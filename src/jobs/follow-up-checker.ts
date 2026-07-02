// src/jobs/follow-up-checker.ts
//
// Bloco 4 — Tasks #20-24 da feature `follow-up-pendente`.
//
// Cron principal do follow-up. **NÃO é hook** — é job paralelo ao pipeline
// de turnos do agente (concept `hook-pipeline`). Roda a cada
// `hook_params.follow_up.cron_interval_ms` (default 600_000 = 10min).
//
// Fluxo por tick:
//
//   1. Lê config viva via findActiveByKey('angelina').hook_params.follow_up.
//      - Sem agent_config OU sem follow_up → skip tick + emit follow_up_config_missing.
//      - `enabled === false` → skip tick + emit follow_up_cron_tick_disabled.
//   2. isWithinBusinessHours (1 chamada por tick — fora do loop por contato).
//      - false → emit follow_up_skipped {reason: 'outside_business_hours'} + skip tick.
//   3. emit follow_up_cron_tick.
//   4. acquireLock(FOLLOW_UP_CHECKER_LOCK_KEY).
//      - false → emit follow_up_lock_skipped + skip tick.
//      - true  → emit follow_up_lock_acquired.
//   5. Query LATERAL JOIN: até 50 candidatos FIFO.
//   6. Loop sequencial (com sleep `rate_limit_sleep_ms` entre envios):
//      - try:
//        - isFollowUpRecentlySent? → skip silencioso (idempotency intra-ciclo, 5min).
//        - canSendFollowUp? → !allowed → emit follow_up_skipped {reason} + continue.
//        - detectarCategoria → renderFollowUpMessage → ZapsterClient.send.
//        - INSERT follow_up_attempts {attempt_number}.
//        - emit follow_up_sent.
//        - if shouldEscalate(attemptNumber) → escalateInline (RF5).
//        - sleep(rate_limit_sleep_ms).
//      - catch err: emit follow_up_send_failed (med) + errors++.
//        Loop CONTINUA — falha em 1 contato não derruba o ciclo.
//   7. finally: releaseLock + emit follow_up_lock_released.
//
// **Escalação RF5 (inline neste arquivo no v1):** quando `attemptNumber >=
// max_attempts_per_24h`, chama `transferToHumanStandalone` + UPDATE `follow_up_disabled=true`
// + emit `follow_up_escalated_to_human`. Bloco 5 valida idempotência adicional
// (`already_disabled` skip) e adiciona smoke unit dedicado.

import pino, { type Logger } from 'pino';
import { sql, eq } from 'drizzle-orm';

import { db } from '../db/client';
import { followUpAttempts, leads, traces } from '../db/schema';
import { findActiveByKey } from '../config/agent-configs';
import {
  acquireLock,
  releaseLock,
  FOLLOW_UP_CHECKER_LOCK_KEY,
} from '../utils/distributed-lock';
import {
  buildFollowUpDetectionQuery,
  canSendFollowUp,
  getLastAttempt,
  isFollowUpRecentlySent,
  isWithinBusinessHours,
  shouldEscalate,
  type FollowUpCandidateRow,
} from '../rules/follow-up-rules';
import {
  detectarCategoria,
  getLastNMessagesContext,
} from '../utils/follow-up-question';
import { renderFollowUpMessage } from '../templates/follow-up-message';
import { transferToHumanStandalone } from '../tools/transfer-to-human-standalone';
import { humanizeEventType } from '../utils/event-type';
import type { ZapsterClient } from '../zapster/client';
import type { FollowUpConfig } from '../config/types';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────────────────────────────────────

export interface FollowUpCheckerDeps {
  zapsterClient: ZapsterClient;
  logger?: Logger;
}

export interface RunFollowUpCheckerResult {
  processed: number;
  sent: number;
  skipped: number;
  escalated: number;
  errors: number;
  /** Quando o tick é pulado inteiro, indica o motivo. */
  skipReason?:
    | 'no_config'
    | 'disabled'
    | 'outside_business_hours'
    | 'lock_held';
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers locais (fora do EventBus per-turn)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INSERT pontual em `traces` para eventos fora-de-turno. Fail-silent — se o
 * INSERT falhar (ex: pool exhausted), logamos via Pino mas não derrubamos o tick.
 */
async function emitTrace(
  eventType: string,
  payload: Record<string, unknown> = {},
  opts: {
    severity?: 'info' | 'med' | 'high';
    contactId?: string | null;
    leadId?: string | null;
  } = {},
): Promise<void> {
  try {
    await db.insert(traces).values({
      eventType,
      payload: { ...payload, severity: opts.severity ?? 'info' },
      contactId: opts.contactId ?? null,
      leadId: opts.leadId ?? null,
    });
  } catch {
    // fail-silent — trace é observability, não correção.
  }
}

/** Formata Date → "DD/MM HH:MM" no timezone configurado. */
function formatTimeBR(date: Date | string, timezone: string): string {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(d).replace(',', ''); // "12/05 14:30" (pt-BR adiciona vírgula em algumas runtimes)
}

/** Helper para sleep entre envios (rate limit). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Monta `interest_summary` para escalação a partir dos campos do lead. */
function buildInterestSummary(lead: FollowUpCandidateRow): string {
  const parts: string[] = [];
  if (lead.event_type) parts.push(humanizeEventType(lead.event_type));
  if (lead.event_date) parts.push(`em ${lead.event_date}`);
  if (lead.guest_count != null) parts.push(`(${lead.guest_count} convidados)`);
  return parts.length === 0 ? 'Lead sem dados estruturados' : parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// runFollowUpChecker — entry-point do tick
// ─────────────────────────────────────────────────────────────────────────────

export async function runFollowUpChecker(
  deps: FollowUpCheckerDeps,
): Promise<RunFollowUpCheckerResult> {
  const logger =
    deps.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const t0 = Date.now();

  // 1. Config viva (cache TTL 30s — hot-reload).
  const agentConfig = await findActiveByKey('angelina');
  const config = (
    agentConfig?.hookParams as { follow_up?: FollowUpConfig } | null | undefined
  )?.follow_up;

  if (!agentConfig || !config) {
    logger.warn(
      { event: 'follow_up_config_missing' },
      'agent_configs hook_params.follow_up missing — skipping tick',
    );
    await emitTrace('follow_up_config_missing', {}, { severity: 'high' });
    return {
      processed: 0,
      sent: 0,
      skipped: 0,
      escalated: 0,
      errors: 0,
      skipReason: 'no_config',
    };
  }

  // 2. Kill switch.
  if (!config.enabled) {
    logger.info({ event: 'follow_up_cron_tick_disabled' }, 'enabled=false');
    await emitTrace('follow_up_cron_tick_disabled', {});
    return {
      processed: 0,
      sent: 0,
      skipped: 0,
      escalated: 0,
      errors: 0,
      skipReason: 'disabled',
    };
  }

  // 3. Business hours.
  if (!isWithinBusinessHours(new Date(), config.business_hours)) {
    logger.info(
      { event: 'follow_up_skipped', reason: 'outside_business_hours' },
      'outside business hours',
    );
    await emitTrace('follow_up_skipped', { reason: 'outside_business_hours' });
    return {
      processed: 0,
      sent: 0,
      skipped: 0,
      escalated: 0,
      errors: 0,
      skipReason: 'outside_business_hours',
    };
  }

  // 4. Lock.
  const acquired = await acquireLock(FOLLOW_UP_CHECKER_LOCK_KEY);
  if (!acquired) {
    logger.info({ event: 'follow_up_lock_skipped' }, 'lock held');
    await emitTrace('follow_up_lock_skipped', {});
    return {
      processed: 0,
      sent: 0,
      skipped: 0,
      escalated: 0,
      errors: 0,
      skipReason: 'lock_held',
    };
  }

  let processed = 0;
  let sent = 0;
  let skipped = 0;
  let escalated = 0;
  let errors = 0;

  try {
    await emitTrace('follow_up_lock_acquired', {});
    await emitTrace('follow_up_cron_tick', {
      threshold_minutes: config.threshold_minutes,
    });

    // 5. Query candidatos FIFO.
    // Cast: db.execute exige `Record<string, unknown>` no generic — fazemos
    // narrow seguro para FollowUpCandidateRow após Array.from.
    const rows = await db.execute<Record<string, unknown>>(
      buildFollowUpDetectionQuery(config.threshold_minutes),
    );
    const candidates = Array.from(rows) as unknown as FollowUpCandidateRow[];

    logger.info(
      { event: 'follow_up_candidates', n: candidates.length },
      `${candidates.length} candidates for this tick`,
    );

    // 6. Loop sequencial.
    for (const row of candidates) {
      processed++;
      const ctxLog = {
        contact_id: row.contact_id,
        lead_id: row.lead_id,
      };

      try {
        // 6a. Idempotency intra-ciclo (5min via traces).
        if (await isFollowUpRecentlySent(row.contact_id, 5)) {
          logger.debug(
            { ...ctxLog, event: 'follow_up_skipped_idempotency' },
            'recently sent (intra-cycle dedup)',
          );
          skipped++;
          continue;
        }

        // 6b. Re-checar business rules pós-query.
        const lastAttempt = await getLastAttempt(row.contact_id);
        const decision = canSendFollowUp(
          {
            status: row.lead_status,
            followUpDisabled: row.follow_up_disabled,
            isHumanActive: row.is_human_active,
            handoffAssumedAt: row.handoff_assumed_at,
          },
          lastAttempt,
          config,
        );
        if (!decision.allowed) {
          logger.info(
            { ...ctxLog, event: 'follow_up_skipped', reason: decision.reason },
            `skipped: ${decision.reason}`,
          );
          await emitTrace(
            'follow_up_skipped',
            { reason: decision.reason },
            { contactId: row.contact_id, leadId: row.lead_id },
          );
          skipped++;
          continue;
        }

        // 6c. Detectar categoria + renderizar mensagem.
        const { categoria, perguntaExtraida } = await detectarCategoria(
          row.contact_id,
          {
            eventType: row.event_type,
            eventDate: row.event_date,
            guestCount: row.guest_count,
          },
        );
        const text = renderFollowUpMessage({
          contactName: row.contact_name ?? '',
          categoria,
          perguntaExtraida,
          templates: config.templates,
          leadInfo: {
            evento: row.event_type != null ? humanizeEventType(row.event_type) : undefined,
            data: row.event_date ?? null,
            convidados: row.guest_count != null ? String(row.guest_count) : undefined,
          },
        });

        // 6d. Send via Zapster.
        if (!row.contact_phone) {
          logger.warn(
            { ...ctxLog, event: 'follow_up_no_phone' },
            'contact has no phone — skip send',
          );
          await emitTrace(
            'follow_up_send_failed',
            { reason: 'no_phone' },
            {
              severity: 'med',
              contactId: row.contact_id,
              leadId: row.lead_id,
            },
          );
          errors++;
          continue;
        }
        await deps.zapsterClient.send({
          recipientId: row.contact_phone,
          recipientType: 'chat',
          text,
        });

        // 6e. INSERT attempt.
        const newAttemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;
        const [insertedAttempt] = await db
          .insert(followUpAttempts)
          .values({
            contactId: row.contact_id,
            leadId: row.lead_id,
            attemptNumber: newAttemptNumber,
            templateUsed: categoria,
          })
          .returning({ id: followUpAttempts.id, sentAt: followUpAttempts.sentAt });

        await emitTrace(
          'follow_up_sent',
          {
            attempt_number: newAttemptNumber,
            categoria,
            template_used: categoria,
          },
          { contactId: row.contact_id, leadId: row.lead_id },
        );
        sent++;

        // 6f. Escalação inline (RF5). Bloco 5 valida com smoke dedicado.
        if (shouldEscalate(newAttemptNumber, config)) {
          // Idempotency: lead pode ter sido manualmente reabilitado entre query e aqui.
          const [freshLead] = await db
            .select({ followUpDisabled: leads.followUpDisabled })
            .from(leads)
            .where(eq(leads.id, row.lead_id))
            .limit(1);

          if (freshLead?.followUpDisabled === true) {
            logger.info(
              { ...ctxLog, event: 'follow_up_escalation_skipped' },
              'already_disabled',
            );
            await emitTrace(
              'follow_up_escalation_skipped',
              { reason: 'already_disabled' },
              { contactId: row.contact_id, leadId: row.lead_id },
            );
          } else {
            // Monta vars do escalation template.
            const ultimas5 = await getLastNMessagesContext(row.contact_id, 5, 100);
            const firstAttempt = lastAttempt; // attemptNumber=1 (anterior à atual)
            const followUp1Time = firstAttempt
              ? formatTimeBR(firstAttempt.sentAt, config.business_hours.timezone)
              : '—';
            const followUp2Time = formatTimeBR(
              insertedAttempt.sentAt,
              config.business_hours.timezone,
            );

            const escalationResult = await transferToHumanStandalone(
              {
                lead_id: row.lead_id,
                reason: '2 follow-ups sem resposta',
                priority: 'normal',
                interest_summary: buildInterestSummary(row),
                suggested_action:
                  'Time interno deve entrar em contato diretamente com o lead.',
                source: 'follow_up_cron',
                ultimas_5_msgs: ultimas5,
                follow_up_1_time: followUp1Time,
                follow_up_2_time: followUp2Time,
                escalationTemplate: config.escalation_support_template,
                supportWhatsapp: agentConfig.supportWhatsapp ?? '',
              },
              { zapsterClient: deps.zapsterClient, logger },
            );

            // UPDATE follow_up_disabled = true (escalação permanente até /reativar-followup).
            await db
              .update(leads)
              .set({ followUpDisabled: true })
              .where(eq(leads.id, row.lead_id));

            await emitTrace(
              'follow_up_escalated_to_human',
              {
                attempt_number: newAttemptNumber,
                support_sent: escalationResult.supportSent,
                lead_updated: escalationResult.leadUpdated,
              },
              {
                severity: 'med',
                contactId: row.contact_id,
                leadId: row.lead_id,
              },
            );
            escalated++;
          }
        }

        // 6g. Rate limit entre envios.
        await sleep(config.rate_limit_sleep_ms);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { ...ctxLog, event: 'follow_up_send_failed', err: message },
          'iteration failed',
        );
        await emitTrace(
          'follow_up_send_failed',
          { reason: 'exception', error: message },
          {
            severity: 'med',
            contactId: row.contact_id,
            leadId: row.lead_id,
          },
        );
        errors++;
        // Continue loop — falha em 1 contato NÃO derruba o ciclo.
      }
    }
  } catch (outerErr) {
    const message =
      outerErr instanceof Error ? outerErr.message : String(outerErr);
    logger.error(
      { event: 'follow_up_query_failed', err: message },
      'detection query failed',
    );
    await emitTrace(
      'follow_up_query_failed',
      { error: message },
      { severity: 'high' },
    );
    errors++;
  } finally {
    try {
      await releaseLock(FOLLOW_UP_CHECKER_LOCK_KEY);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { event: 'follow_up_lock_release_failed', err: message },
        'lock release failed (will auto-release on connection close)',
      );
    }
    await emitTrace('follow_up_lock_released', {});

    const elapsedMs = Date.now() - t0;
    logger.info(
      {
        event: 'follow_up_cron_tick_complete',
        elapsed_ms: elapsedMs,
        processed,
        sent,
        skipped,
        escalated,
        errors,
      },
      'tick complete',
    );
  }

  return { processed, sent, skipped, escalated, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// startFollowUpCron — wrapper de agendamento (chamado pelo main.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inicia o loop de cron via `setInterval`. Retorna o handle para `clearInterval`
 * no graceful shutdown. NÃO espera o primeiro tick — schedule é assíncrono.
 *
 * O intervalo é lido na **boot** de `findActiveByKey('angelina').hook_params.follow_up.cron_interval_ms`
 * (default 600_000 = 10min). Mudança em runtime NÃO replica — exige restart
 * do worker para reagendar (trade-off aceito; setInterval rate-limit é estável).
 *
 * @param deps `zapsterClient` (instância compartilhada) + logger opcional.
 * @returns Handle do interval (`NodeJS.Timeout`) — passar para `clearInterval` no shutdown.
 */
export async function startFollowUpCron(
  deps: FollowUpCheckerDeps,
): Promise<NodeJS.Timeout> {
  const logger =
    deps.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });

  // Lê config 1× para obter cron_interval_ms; default 10min se ausente.
  const agentConfig = await findActiveByKey('angelina');
  const config = (
    agentConfig?.hookParams as { follow_up?: FollowUpConfig } | null | undefined
  )?.follow_up;
  const intervalMs = config?.cron_interval_ms ?? 600_000;

  logger.info(
    { event: 'follow_up_cron_starting', interval_ms: intervalMs },
    'follow-up cron scheduled',
  );

  // Não dispara IMEDIATAMENTE — primeira execução só após o primeiro intervalo.
  // Trade-off: evita race com boot do consumer/worker. Se quiser primeira
  // execução imediata, ramificar com `runFollowUpChecker(deps).catch(...)`.
  const handle = setInterval(() => {
    runFollowUpChecker(deps).catch((err) => {
      logger.error(
        { event: 'follow_up_cron_uncaught', err: err.message ?? String(err) },
        'runFollowUpChecker threw — interval continues',
      );
    });
  }, intervalMs);

  return handle;
}
