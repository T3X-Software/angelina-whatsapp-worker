// src/queue/consumer.ts
//
// BullMQ Worker da queue `inbound`. Substitui o stub do Bloco 0 em main.ts.
//
// Comportamento por job (atualizado no Bloco 12.5 — fix duplicidade):
//   1. Lê `phone` do `job.data` (acumulado pelo producer).
//   2. Chama `drainBucket(redis, phone)` para obter array de mensagens
//      consolidadas pelo debouncer rolling-window (Task #17).
//   3. Loga "processing job=... attempt=N consolidated=K" — evidência do
//      debounce funcionando.
//   4. Para garantir que cada `zapster_message_id` da janela vire 1 row
//      INBOUND (auditoria + idempotência contra retransmits do Zapster):
//        - Resolve contact + lead a partir do phone (mesmo helper do harness).
//        - Faz `claimMessage` em CADA uma das N-1 primeiras mensagens (a
//          última é deixada para o harness claim normal).
//        - Falhas individuais são logadas e seguem (best-effort).
//   5. Chama `harnessRun(lastPayload, lastHeaders)` UMA única vez. O L1
//      composer lê todas as user rows do contato em ordem cronológica e o
//      Anthropic SDK aceita user-messages consecutivos sem reclamar.
//
// Concurrency 5 + lockDuration 60s — espaço suficiente para o turno completo
// do harness (~15s típicos, com folga 4×).

import { Worker, type Job } from 'bullmq';

import { getRedis } from './connection';
import { drainBucket } from './debouncer';
import { QUEUE_NAME, type InboundJobData } from './producer';
import type { WebhookPayload } from '../edge/payload';
import type { RelevantHeaders } from './producer';
import { run as harnessRun } from '../harness/loop';
import { resolveContactFromPhone, normalizeE164 } from '../contacts/resolveContact';
import { resolveActiveLead } from '../contacts/resolveActiveLead';
import { claimMessage } from '../harness/idempotency';
import { findActiveByKey } from '../config/agent-configs';
import {
  detectSupportInbound,
  isSupportPhone,
} from '../edge/detect-support-inbound';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export type MinimalLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** Forma de cada item retornado pelo `drainBucket` (mesmo shape pushed pelo producer). */
type DrainedMessage = {
  payload: WebhookPayload;
  headers: RelevantHeaders;
};

// ─────────────────────────────────────────────────────────────────────────────
// Processor
// ─────────────────────────────────────────────────────────────────────────────

function makeProcessor(logger: MinimalLogger) {
  return async function processor(job: Job<InboundJobData>): Promise<void> {
    const { phone } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

    // Smoke C: forçar fail por env var, sem tocar o código permanente.
    if (process.env.FORCE_FAIL === '1') {
      logger.warn(
        { jobId: job.id, attempt, FORCE_FAIL: true },
        'FORCE_FAIL=1 — throwing to test DLQ',
      );
      throw new Error('test fail');
    }

    let consolidated: DrainedMessage[] = [];
    try {
      consolidated = await drainBucket<DrainedMessage>(getRedis(), phone);
    } catch (err) {
      logger.error(
        {
          event: 'drain_bucket_failed',
          jobId: job.id,
          phone,
          err: err instanceof Error ? err.message : String(err),
        },
        'drainBucket failed',
      );
      // Re-throw para o BullMQ contar attempt e o DLQ handler agir após 3.
      throw err;
    }

    // Sentinel: se a LIST veio vazia (TTL estourou ou rotação rara), usar
    // pelo menos a mensagem que disparou o job (carregada no jobData).
    if (consolidated.length === 0) {
      logger.warn(
        {
          event: 'bucket_empty_using_sentinel',
          jobId: job.id,
          phone,
        },
        'bucket vazio — usando sentinel do jobData',
      );
      consolidated = [{ payload: job.data.payload, headers: job.data.headers }];
    }

    logger.info(
      {
        event: 'processing',
        jobId: job.id,
        phone,
        attempt,
        consolidated: consolidated.length,
        zapster_message_ids: consolidated
          .map((m) => m.payload.data.message.id)
          .filter(Boolean),
      },
      `processing job=${job.id} attempt=${attempt} consolidated=${consolidated.length}`,
    );

    // Mensagem primária do bucket (a mais recente). É ela que dispara o
    // turno principal — declarada aqui para também ser usada pelo Bloco 9
    // detection abaixo.
    const primary: DrainedMessage = consolidated[consolidated.length - 1];
    const earlies = consolidated.slice(0, -1);

    // ── Bloco 9 — webhook detection do support_whatsapp ──────────────────
    //
    // Antes de processar como turno do cliente, verifica se o sender é o
    // vendedor (support_whatsapp) respondendo a um lead em handoff. Se for E
    // a mensagem NÃO for um comando admin (`/...`), executa detection +
    // UPDATE idempotente em `leads.handoff_assumed_at` e CURTO-CIRCUITA o
    // job — NÃO chama `harnessRun`. Razão: mensagem do vendedor não é turno
    // do cliente; tratá-la como tal causaria a IA "responder ao vendedor"
    // (bug óbvio).
    //
    // Prioridade (cobre overlap support_whatsapp ⊆ admin_phones):
    //   1. mensagem começa com `/` → trata como admin (segue fluxo normal;
    //      admin-router roda como hook BEFORE_REQUEST e processa o comando,
    //      mesmo se phone é admin+support).
    //   2. phone == support_whatsapp (e não é admin cmd) → detection +
    //      shortCircuit job.
    //   3. phone não é support_whatsapp → segue fluxo normal (cliente comum
    //      ou admin sem prefixo `/`).
    //
    // Cuidado: este detection roda sobre a MENSAGEM PRIMÁRIA do bucket
    // (a mais recente). Mensagens consecutivas do mesmo vendedor (mesmo
    // burst) cairão aqui também, mas o UPDATE em `detectSupportInbound` é
    // idempotente (`WHERE handoff_assumed_at IS NULL`), então só a 1ª seta
    // o timestamp.
    try {
      const config = await findActiveByKey('angelina');
      if (config !== null) {
        const supportConfig = config.supportWhatsapp ?? null;
        const primaryText = primary.payload.data.message.text ?? '';
        const isAdminCommand = primaryText.trimStart().startsWith('/');

        if (!isAdminCommand && isSupportPhone(phone, supportConfig)) {
          const result = await detectSupportInbound(phone);
          if (result.detected) {
            logger.info(
              {
                event: 'handoff_assumed_via_webhook',
                severity: 'med',
                lead_id: result.leadId,
                source_phone: phone,
                already_assumed: result.alreadyAssumed,
                jobId: job.id,
                zapster_message_id: primary.payload.data.message.id,
              },
              `handoff_assumed_via_webhook lead=${result.leadId} already_assumed=${result.alreadyAssumed}`,
            );
          } else {
            logger.info(
              {
                event: 'support_inbound_no_task',
                severity: 'info',
                source_phone: phone,
                reason: result.reason,
                jobId: job.id,
                zapster_message_id: primary.payload.data.message.id,
              },
              `support_inbound_no_task source_phone=${phone} reason=${result.reason}`,
            );
          }
          // Curto-circuita: NÃO chama harnessRun. Mensagem do vendedor NÃO
          // vira turno do cliente. Auditoria fica via traces de log estruturado
          // (event:handoff_assumed_via_webhook ou support_inbound_no_task).
          return;
        }
      }
    } catch (err) {
      // Falha no lookup de config OU na detection NÃO derruba o turno —
      // segue fluxo normal (path degradado). Em prod, este caminho dispara
      // alerta via log error.
      logger.error(
        {
          event: 'support_inbound_detection_failed',
          jobId: job.id,
          phone,
          err: err instanceof Error ? err.message : String(err),
        },
        'support inbound detection failed — falling back to normal harness run',
      );
    }

    // ── Pré-claim das mensagens 0..N-2 (Bloco 12.5 — fix duplicidade) ────
    //
    // Cada `zapster_message_id` precisa ter sua row INBOUND para:
    //   (a) integridade do histórico no L1 (Anthropic vê cada user msg);
    //   (b) idempotência contra retransmits do Zapster (UNIQUE constraint).
    //
    // `primary` (mais recente) e `earlies` (anteriores) já foram declarados
    // antes do bloco de detection do Bloco 9. A última fica para o harness
    // claim normalmente — ela é a mensagem "primária" que dispara este turno.
    if (earlies.length > 0) {
      try {
        const normPhone = normalizeE164(phone);
        const contact = await resolveContactFromPhone(normPhone);
        const leadId = await resolveActiveLead(contact.contactId);

        let preclaimedNew = 0;
        let preclaimedDup = 0;
        for (const entry of earlies) {
          try {
            const result = await claimMessage(entry.payload, contact.contactId, leadId);
            if (result.isDuplicate) preclaimedDup += 1;
            else preclaimedNew += 1;
          } catch (err) {
            logger.warn(
              {
                event: 'preclaim_failed',
                zapster_message_id: entry.payload.data.message.id,
                err: err instanceof Error ? err.message : String(err),
              },
              'failed to pre-claim consolidated message — continuing',
            );
          }
        }

        logger.info(
          {
            event: 'consolidated_preclaimed',
            jobId: job.id,
            preclaimed_new: preclaimedNew,
            preclaimed_duplicate: preclaimedDup,
            primary_zapster_id: primary.payload.data.message.id,
          },
          `pre-claimed ${preclaimedNew} new + ${preclaimedDup} dup of ${earlies.length}`,
        );
      } catch (err) {
        // Se não conseguimos resolver contact, seguimos com harness na
        // primária mesmo assim — degraded mode (algumas msgs early ficam
        // sem row INBOUND, mas o turno responde algo ao usuário).
        logger.error(
          {
            event: 'consolidate_resolve_failed',
            jobId: job.id,
            phone,
            err: err instanceof Error ? err.message : String(err),
          },
          'failed to resolve contact for pre-claim — running harness on primary only',
        );
      }
    }

    // ── Harness — única chamada por job (turno consolidado) ──────────────
    const result = await harnessRun(primary.payload, primary.headers);
    logger.info(
      {
        event: 'harness_loop_result',
        jobId: job.id,
        status: result.status,
        turn_id: result.turnId,
        inbound_id: result.inboundMessageId,
        outbound_id: result.outboundMessageId,
        reason: result.reason,
      },
      `harness loop completed: ${result.status}`,
    );
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker singleton
// ─────────────────────────────────────────────────────────────────────────────

let cachedWorker: Worker<InboundJobData> | null = null;

/**
 * Sobe o consumer da queue `inbound`. Singleton — chamadas subsequentes
 * retornam o mesmo Worker.
 *
 * Concurrency 5 — múltiplos contatos em paralelo.
 * lockDuration 60s — turno harness completo cabe folgado (~15s típicos).
 */
export function startConsumer(logger: MinimalLogger): Worker<InboundJobData> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<InboundJobData>(QUEUE_NAME, makeProcessor(logger), {
    connection: getRedis(),
    concurrency: 5,
    lockDuration: 60_000,
  });

  cachedWorker.on('ready', () => {
    logger.info(
      { event: 'consumer_ready', queue: QUEUE_NAME, concurrency: 5 },
      'BullMQ consumer ready',
    );
  });

  return cachedWorker;
}

/** Fecha o consumer. Idempotente. Usado pelo graceful shutdown. */
export async function closeConsumer(): Promise<void> {
  if (!cachedWorker) return;
  try {
    await cachedWorker.close();
  } catch {
    // ignore
  } finally {
    cachedWorker = null;
  }
}
