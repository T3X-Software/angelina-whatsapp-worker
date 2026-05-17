// src/tools/transfer-to-human-standalone.ts
//
// Bloco 2 — Tasks #11 + #12 da feature `follow-up-pendente`.
//
// **HELPER INTERNO** (não é tool callable pelo Claude). Replica os passos
// críticos do `transfer-trigger` SEM depender do `HarnessContext`/EventBus
// per-turn — permite que jobs/crons disparem handoff fora do pipeline de
// turnos do agente.
//
// Decisão D1: duplicação consciente em arquivo separado (não refactor da
// tool `transfer_to_human` em produção). Trade-off aceito — risco de
// regressão na tool em produção (`whatsapp-message-splitting-and-handoff-continuity`)
// supera o ganho de DRY no v1. TODO: extrair helper compartilhado em v2.
//
// **Diferenças vs. `transfer-trigger.ts` (5 passos do hot-handoff):**
//   - NÃO envia "mensagem de transição ao cliente" (passo 2 do hot-handoff)
//     — escalação RF5 acontece quando o cliente já está sem responder; envio
//     duplicado seria ruído. O cliente é avisado pelo próprio time interno.
//   - NÃO cria task no CRM (passo 3) — a tabela `tasks` é alimentada pelo
//     fluxo HOT; aqui apenas notificamos o support_whatsapp.
//   - NÃO insere timeline_events (passo 5) — para escalação RF5, o evento
//     em `traces` é suficiente; `follow_up_escalated_to_human` no Bloco 5
//     complementa o trail de auditoria.
//   - PRESERVA: UPDATE `leads.is_human_active=true` + INSERT em `traces` com
//     `event_type='transfer_to_human'` e payload `source` indicando origem.
//
// **Modo assistido:** após a UPDATE, o lead fica em `assisted` (is_human_active=true
// + handoff_assumed_at IS NULL), igual ao hot-handoff. O response-guard e
// classifier passam a interceptar mensagens da IA — defesa em profundidade
// das 4 camadas (concept `assisted-handoff-mode`) continua válida.
//
// **Idempotência da escalação:** este helper NÃO checa se o lead já está em
// modo `assisted/blocked` (diferente da tool original). Responsabilidade do
// caller (Bloco 5 `escalateToHuman`) checar `leads.follow_up_disabled` antes
// de invocar — se já for true, emit `follow_up_escalation_skipped` e retornar
// sem chamar este helper.

import pino, { type Logger } from 'pino';
import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import { traces } from '../db/schema';
import type { ZapsterClient } from '../zapster/client';
import { renderEscalationMessage } from '../templates/follow-up-message';
import { humanizeEventType } from '../utils/event-type';
import { formatPhone } from '../utils/phone';

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

export interface TransferToHumanStandaloneInput {
  /** UUID do lead a transferir. */
  lead_id: string;
  /** Motivo (vai em traces.payload + interest_summary do CRM). */
  reason: string;
  /** Prioridade da escalação (vai em traces.payload). */
  priority: 'urgent' | 'normal';
  /**
   * Resumo do interesse atual — sobrescreve `leads.interest_summary` se passado.
   * Quando null, COALESCE preserva o valor anterior (ex: handoff prévio).
   */
  interest_summary?: string;
  /**
   * Ação prescritiva sugerida — sobrescreve `leads.suggested_action` se passado.
   * Quando null, COALESCE preserva.
   */
  suggested_action?: string;
  /** Identifica origem da chamada (ex: 'follow_up_cron'). Vai em traces.payload. */
  source: string;

  // ── Vars para o template de escalação ────────────────────────────────────
  /** Bloco formatado com últimas 5 msgs (Cliente: ... / Angelina: ...). */
  ultimas_5_msgs: string;
  /** Timestamp formatado BR da 1ª tentativa de follow-up (ex: "12/05 14:30"). */
  follow_up_1_time: string;
  /** Timestamp formatado BR da 2ª tentativa de follow-up. */
  follow_up_2_time: string;

  // ── Config viva (caller lê de findActiveByKey + hook_params.follow_up) ───
  /** Template literal de `hook_params.follow_up.escalation_support_template`. */
  escalationTemplate: string;
  /** Número E.164 do support_whatsapp (lido de `agent_configs.support_whatsapp`). */
  supportWhatsapp: string;
}

export interface TransferToHumanStandaloneDeps {
  zapsterClient: ZapsterClient;
  /** Logger Pino opcional — default usa LOG_LEVEL do env. */
  logger?: Logger;
}

export interface TransferToHumanStandaloneResult {
  /** true se o helper concluiu sem erro fatal (lead atualizado). */
  success: boolean;
  /** true se o UPDATE em leads efetivou. */
  leadUpdated: boolean;
  /** true se a msg ao support_whatsapp foi enviada. */
  supportSent: boolean;
  /** Texto literal enviado ao support (útil para auditoria). */
  supportTextRendered?: string;
  /** Quando success=false, descreve o erro. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementação
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispara handoff de um lead para humano sem depender do pipeline de turnos.
 *
 * Fluxo:
 *   1. SELECT snapshot do lead + contato + telefone primário (1 round-trip).
 *   2. UPDATE leads SET is_human_active=true (+ interest_summary, suggested_action).
 *   3. Renderiza msg de escalação via `renderEscalationMessage` (template literal
 *      vindo de `hook_params.follow_up.escalation_support_template`).
 *   4. Envia ao `supportWhatsapp` via ZapsterClient (fail-open — loga e segue).
 *   5. INSERT em traces com event_type='transfer_to_human' + payload.source.
 *
 * Errors em (3-5) são logados mas NÃO derrubam o helper — o caller decide o que
 * fazer com `success:false`.
 *
 * @param input parâmetros + vars + template + supportWhatsapp.
 * @param deps zapsterClient (DI) + logger opcional.
 */
export async function transferToHumanStandalone(
  input: TransferToHumanStandaloneInput,
  deps: TransferToHumanStandaloneDeps,
): Promise<TransferToHumanStandaloneResult> {
  const logger =
    deps.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });

  // ── 1. Snapshot do lead ────────────────────────────────────────────────
  const leadRows = await db.execute<{
    contact_id: string;
    contact_name: string | null;
    contact_phone: string | null;
    event_type: string | null;
    event_date: string | null;
    guest_count: number | null;
  }>(sql`
    SELECT
      l.contact_id           AS contact_id,
      c.name                 AS contact_name,
      (
        SELECT phone FROM contact_phones cp
         WHERE cp.contact_id = c.id
         ORDER BY cp.is_primary DESC NULLS LAST,
                  cp.is_whatsapp DESC NULLS LAST
         LIMIT 1
      )                      AS contact_phone,
      l.event_type::text     AS event_type,
      l.event_date::text     AS event_date,
      l.guest_count          AS guest_count
    FROM leads l
    JOIN contacts c ON c.id = l.contact_id
    WHERE l.id = ${input.lead_id}
    LIMIT 1
  `);
  const leadArr = Array.from(leadRows) as Array<{
    contact_id: string;
    contact_name: string | null;
    contact_phone: string | null;
    event_type: string | null;
    event_date: string | null;
    guest_count: number | null;
  }>;

  if (leadArr.length === 0) {
    logger.warn(
      { event: 'transfer_to_human_standalone_lead_not_found', lead_id: input.lead_id },
      'lead not found — aborting standalone handoff',
    );
    return {
      success: false,
      leadUpdated: false,
      supportSent: false,
      error: 'lead_not_found',
    };
  }
  const lead = leadArr[0];

  // ── 2. UPDATE leads (mantém em modo `assisted` — handoff_assumed_at preservado) ─
  let leadUpdated = false;
  try {
    await db.execute(sql`
      UPDATE leads SET
        is_human_active  = true,
        interest_summary = COALESCE(${input.interest_summary ?? null}, interest_summary),
        suggested_action = COALESCE(${input.suggested_action ?? null}, suggested_action)
      WHERE id = ${input.lead_id}
    `);
    leadUpdated = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        event: 'transfer_to_human_standalone_update_failed',
        lead_id: input.lead_id,
        error: message,
      },
      'UPDATE leads failed in standalone handoff',
    );
    return {
      success: false,
      leadUpdated: false,
      supportSent: false,
      error: `update_failed: ${message}`,
    };
  }

  // ── 3. Render + 4. Send ao support_whatsapp ────────────────────────────
  let supportSent = false;
  let supportTextRendered = '';

  if (!input.supportWhatsapp || input.supportWhatsapp.trim() === '') {
    logger.warn(
      {
        event: 'transfer_to_human_standalone_support_unset',
        lead_id: input.lead_id,
      },
      'supportWhatsapp empty — skipping send',
    );
  } else {
    const guestCountStr =
      lead.guest_count != null ? `${lead.guest_count} pessoas` : '—';

    const vars = {
      nome: lead.contact_name ?? '—',
      whatsapp: formatPhone(lead.contact_phone ?? null),
      evento: humanizeEventType(lead.event_type),
      // ISO YYYY-MM-DD → auto-conv DD/MM/YYYY pelo `interpolateTemplate` (key 'data').
      data: lead.event_date,
      convidados: guestCountStr,
      ultimas_5_msgs: input.ultimas_5_msgs,
      follow_up_1_time: input.follow_up_1_time,
      follow_up_2_time: input.follow_up_2_time,
    };

    supportTextRendered = renderEscalationMessage({
      template: input.escalationTemplate,
      vars,
    });

    try {
      await deps.zapsterClient.send({
        recipientId: input.supportWhatsapp,
        recipientType: 'chat',
        text: supportTextRendered,
      });
      supportSent = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          event: 'transfer_to_human_standalone_send_failed',
          lead_id: input.lead_id,
          error: message,
        },
        'send to support_whatsapp failed',
      );
      // Fail-open — lead já está atualizado; o trace abaixo registra que send falhou.
    }
  }

  // ── 5. INSERT em traces (sem messageId — fora de turno) ────────────────
  try {
    await db.insert(traces).values({
      eventType: 'transfer_to_human',
      payload: {
        source: input.source,
        reason: input.reason,
        priority: input.priority,
        has_interest_summary: input.interest_summary != null,
        has_suggested_action: input.suggested_action != null,
        support_sent: supportSent,
        severity: 'info',
      },
      contactId: lead.contact_id,
      leadId: input.lead_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        event: 'transfer_to_human_standalone_trace_failed',
        lead_id: input.lead_id,
        error: message,
      },
      'trace insert failed (non-fatal)',
    );
  }

  logger.info(
    {
      event: 'transfer_to_human',
      source: input.source,
      lead_id: input.lead_id,
      contact_id: lead.contact_id,
      support_sent: supportSent,
      lead_updated: leadUpdated,
    },
    'standalone handoff complete',
  );

  return {
    success: true,
    leadUpdated,
    supportSent,
    supportTextRendered,
  };
}
