// src/hooks/transfer-trigger.ts
//
// Bloco 6 — Task 36. PRIMEIRO hook de AFTER_MODEL (antes de format-whatsapp).
//
// ⚠️ INVARIANTE 5: este é o ÚNICO lugar autorizado a chamar
// `ZapsterClient.send()` SEM passar pelo response-guard. A justificativa está
// documentada em `docs/concepts/hot-handoff.md` e `docs/concepts/response-guard.md`:
//   - Passo 1 seta `leads.is_human_active=true` ANTES dos sends — ou seja,
//     a partir desse instante o response-guard bloquearia QUALQUER outra
//     mensagem da IA neste lead. A mensagem de transição precisa chegar ao
//     cliente "à frente" desse bloqueio, então é enviada direto.
//   - Após os 5 passos, o pipeline aborta (`shortCircuit:true`), garantindo
//     que `format-whatsapp` e `human-delay` + `response-guard` NÃO rodem.
//
// Sequência (5 passos — concept hot-handoff, ordem OBRIGATÓRIA):
//   1. UPDATE leads SET is_human_active=true, interest_summary=$2,
//      suggested_action=$3 WHERE id=$1
//      (Bloco 3: 2 campos novos populados a partir dos args opcionais
//       passados pelo Claude na tool `transfer_to_human`)
//   2. ZapsterClient.send(transferMessage)            ← bypassa response-guard
//   3. INSERT INTO tasks ('Lead HOT — atendimento', FOLLOWUP, HIGH, PENDING)
//   4. ZapsterClient.send(supportMessage)             ← support_whatsapp
//      (Bloco 3: usa template em `agent_configs.hook_params.handoff_support_message_template`
//       interpolado com 8 vars: nome, whatsapp, evento, data, convidados,
//       preferencia, interesse, acao_sugerida)
//   5. INSERT INTO timeline_events ('Handoff HOT', OTHER) + emit handoff_complete
//
// Atomicidade: 1+3+5 ficam em transação Drizzle (passos de banco). 2+4 (sends)
// rodam fora da transação — não dá rollback de mensagem enviada. Estratégia:
//   1. abre transação
//   2. UPDATE is_human_active=true (+ interest_summary + suggested_action)
//   3. INSERT tasks
//   4. INSERT timeline_events
//   5. commit
//   6. send 2 (cliente)
//   7. send 4 (Juliano) — se support_whatsapp não vazio
// Se 6 ou 7 falham, NÃO revertemos (Sergio confirma; emite warn `handoff_partial`).
//
// Feature C (item 3.1): passo 4 envia para TODOS os `hook_params.notification_targets`
// (E.164, normalizados + deduplicados). Lista vazia → fallback `support_whatsapp`.
// Ambos vazios → warn `handoff_notification_targets_empty` e NÃO envia; demais
// passos (1, 2 cliente, 3, 5) acontecem normalmente. Falha de um alvo não impede
// os outros (cada send tem seu try/catch → `handoff_partial`).

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { Hook, HookResult, HarnessContext } from '../harness/types';
import type { ZapsterClient } from '../zapster/client';
import { interpolateTemplate } from '../utils/template';
import { humanizeEventType } from '../utils/event-type';
import { formatPhone } from '../utils/phone';
import { getLeadHandoffState } from '../utils/assisted-mode';
import { resolveNotificationTargets } from '../utils/notification-targets';

interface HookParamsShape {
  transfer_message?: string;
  /**
   * Bloco 3 — feature `whatsapp-message-splitting-and-handoff-continuity`.
   * Template humanizado renderizado via `interpolateTemplate` no passo 4.
   * Vars suportadas: nome, whatsapp, evento, data, convidados, preferencia,
   * interesse, acao_sugerida.
   */
  handoff_support_message_template?: string;
  /**
   * Feature C (item 3.1) — números E.164 que recebem a notificação de handoff.
   * A plataforma grava (toggle "recebe notificação do agente" por usuário).
   * Vazio/ausente → fallback para `support_whatsapp` (comportamento legado).
   * O primeiro alvo vira `tasks.assigned_to_phone` (âncora do webhook, Bloco 9).
   */
  notification_targets?: string[];
}

const DEFAULT_TRANSFER_MESSAGE =
  'Perfeito, vou te conectar com um especialista agora 👌';

/** Redact de telefone para tracing: 4 primeiros + *** + 2 últimos. */
function redactPhone(p: string): string {
  return p.length <= 6 ? '***' : `${p.slice(0, 4)}***${p.slice(-2)}`;
}

/**
 * Detecta se o handoff deve ser disparado neste turno. Aciona quando:
 *   (a) `ctx.handoffRequested === true` (sinal explícito setado pelo
 *       HarnessLoop após processar tool_use de `transfer_to_human`); OU
 *   (b) última `tool_call` foi `classify_lead` com classification='HOT'
 *       AND lead tem todos os 3 dados obrigatórios (event_type, event_date,
 *       guest_count). Detectado via `ctx.lastToolCall` (Bloco 7 — populado
 *       pelo loop após cada tool dispatch).
 */
function shouldTrigger(ctx: HarnessContext): {
  trigger: boolean;
  reason?: string;
} {
  if (ctx.handoffRequested === true) {
    return { trigger: true, reason: 'handoff_requested_by_tool' };
  }

  // Ramo (b) — última tool foi `classify_lead` com classification='HOT' e
  // lead com event_type+event_date+guest_count preenchidos.
  const last = ctx.lastToolCall;
  if (
    last &&
    last.name === 'classify_lead' &&
    last.result.success === true
  ) {
    const args = last.input as { classification?: string } | undefined;
    if (
      args?.classification === 'HOT' &&
      ctx.lead?.eventType != null &&
      ctx.lead?.eventDate != null &&
      ctx.lead?.guestCount != null
    ) {
      return {
        trigger: true,
        reason: 'classify_lead_hot_with_complete_lead_data',
      };
    }
  }

  return { trigger: false };
}

/**
 * Bloco 3 — extrai os 2 args opcionais (`interest_summary`, `suggested_action`)
 * do último `tool_use` do turno, quando este foi `transfer_to_human`. Devolve
 * `null` em ambos quando o handoff veio do ramo (b) (`classify_lead HOT`).
 */
function extractInterestArgs(
  ctx: HarnessContext,
): { interestSummary: string | null; suggestedAction: string | null } {
  const last = ctx.lastToolCall;
  if (last && last.name === 'transfer_to_human') {
    const input = last.input as
      | { interest_summary?: string; suggested_action?: string }
      | undefined;
    return {
      interestSummary: input?.interest_summary?.trim() || null,
      suggestedAction: input?.suggested_action?.trim() || null,
    };
  }
  return { interestSummary: null, suggestedAction: null };
}

/**
 * Bloco 3 — busca `preference_visit` em `contact_facts` (latest non-superseded).
 * Retorna `null` quando o contato não tem fact deste tipo. Pattern
 * `append-only-facts`: pegar o registro com `superseded_by IS NULL` e
 * `confidence >= 0.5` (default), ordenado por `extracted_at DESC`.
 *
 * `fact_value` é JSONB e pode estar em 2 formas (defensivo):
 *   - string direta (legado / `remember_fact` simples)
 *   - objeto `{ value: "..." }` ou `{ text: "..." }` (estrutura genérica)
 */
async function fetchPreferenceVisit(
  contactId: string,
): Promise<string | null> {
  const rows = await db.execute<{ fact_value: unknown }>(sql`
    SELECT fact_value
      FROM contact_facts
     WHERE contact_id = ${contactId}
       AND fact_type = 'preference_visit'
       AND superseded_by IS NULL
     ORDER BY extracted_at DESC
     LIMIT 1
  `);
  const arr = Array.from(rows) as Array<{ fact_value: unknown }>;
  if (arr.length === 0) return null;

  const raw = arr[0].fact_value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.preference === 'string') return obj.preference;
  }
  return null;
}

export function createTransferTriggerHook(client: ZapsterClient): Hook {
  return {
    name: 'transfer-trigger',
    phase: 'AFTER_MODEL',

    async run(ctx: HarnessContext): Promise<HookResult> {
      const { trigger, reason } = shouldTrigger(ctx);
      if (!trigger) {
        ctx.eventBus.emitHook(
          'transfer-trigger',
          'AFTER_MODEL',
          { triggered: false },
          'info',
        );
        return {};
      }

      // Sem lead, não dá para atualizar `is_human_active` nem criar task
      // associada. Aborta o handoff e segue o pipeline normal — a IA pode
      // ainda enviar uma resposta nesse turno (não ideal, mas evita crash).
      if (!ctx.lead) {
        ctx.eventBus.emit(
          'handoff_aborted_no_lead',
          {
            reason: 'transfer-trigger fired but ctx.lead is null',
            handoff_reason: reason,
          },
          'high',
        );
        return {};
      }

      const leadId = ctx.lead.id;

      // ─── Bloco 10 — gate de idempotência de handoff ────────────────────
      // Edge case identificado no [note] do Bloco 6: caminho `classify_lead →
      // HOT → transfer-trigger` pode disparar quando o lead JÁ está em modo
      // assistido ou bloqueado (handoff anterior). Nesses casos, executar a
      // sequência de 5 passos novamente cria task duplicada (FOLLOWUP HIGH),
      // re-envia mensagem de transição e re-notifica suporte — comportamento
      // que o operador acha confuso.
      //
      // Política: handoff dispara NO MÁXIMO 1× por lead. Se já está em
      // handoff, curto-circuita ANTES do passo 1. Defensivo: se a query do
      // helper falhar, segue adiante (fail-open) — a defesa em profundidade
      // (response-guard 3a/3b) ainda intercepta as mensagens da IA.
      try {
        const handoffState = await getLeadHandoffState(leadId);
        if (handoffState.mode === 'assisted' || handoffState.mode === 'blocked') {
          ctx.eventBus.emit(
            'transfer_trigger_skipped_in_handoff',
            {
              contact_id: ctx.contact.id,
              lead_id: leadId,
              state_mode: handoffState.mode,
              handoff_reason: reason,
            },
            'info',
          );
          // Aborta o pipeline — IA NÃO envia mensagem adicional. A defesa
          // em profundidade (Blocos 5+7) cobre eventual mensagem residual.
          return { shortCircuit: true };
        }
      } catch (err) {
        // Fail-open: erro de DB não impede o handoff legítimo. Emite med
        // para observabilidade — se ocorrer com frequência, investigar.
        ctx.eventBus.emit(
          'transfer_trigger_gate_lookup_failed',
          {
            lead_id: leadId,
            error: err instanceof Error ? err.message : String(err),
          },
          'med',
        );
      }

      const params = (ctx.config?.hookParams ?? {}) as HookParamsShape;
      const transferMessage =
        params.transfer_message ?? DEFAULT_TRANSFER_MESSAGE;
      const supportTemplate = params.handoff_support_message_template;
      const supportWhatsapp = ctx.config?.supportWhatsapp ?? '';

      // Feature C (3.1) — resolve os alvos de notificação (N números E.164),
      // com fallback para `support_whatsapp` quando `notification_targets` vazio.
      const { targets: notificationTargets, source: notificationTargetsSource } =
        resolveNotificationTargets(params.notification_targets, supportWhatsapp);

      // Bloco 3 — args opcionais vindos do Claude via tool `transfer_to_human`.
      const { interestSummary, suggestedAction } = extractInterestArgs(ctx);

      // ─── Passos 1, 3, 5 em transação ───────────────────────────────────
      let taskId: string | null = null;
      let timelineEventId: string | null = null;
      let leadSnapshot: {
        eventType: string | null;
        eventDate: string | null;
        guestCount: number | null;
        assignedToId: string | null;
        contactName: string | null;
        contactPhone: string | null;
      } = {
        eventType: null,
        eventDate: null,
        guestCount: null,
        assignedToId: null,
        contactName: null,
        contactPhone: null,
      };

      try {
        await db.transaction(async (tx) => {
          // Snapshot do lead para a notificação ao Juliano e para o metadata.
          // Bloco 3: também busca telefone primário do contato (para template
          // {{whatsapp}}) — usa contact_phones.is_primary=true (fallback first).
          const leadRows = await tx.execute<{
            event_type: string | null;
            event_date: string | null;
            guest_count: number | null;
            assigned_to_id: string | null;
            contact_name: string | null;
            contact_phone: string | null;
          }>(sql`
            SELECT l.event_type::text       AS event_type,
                   l.event_date::text       AS event_date,
                   l.guest_count            AS guest_count,
                   l.assigned_to_id         AS assigned_to_id,
                   c.name                   AS contact_name,
                   (
                     SELECT phone FROM contact_phones cp
                      WHERE cp.contact_id = c.id
                      ORDER BY cp.is_primary DESC NULLS LAST,
                               cp.is_whatsapp DESC NULLS LAST
                      LIMIT 1
                   )                        AS contact_phone
              FROM leads l
              JOIN contacts c ON c.id = l.contact_id
             WHERE l.id = ${leadId}
             LIMIT 1
          `);
          const leadArr = Array.from(leadRows) as Array<{
            event_type: string | null;
            event_date: string | null;
            guest_count: number | null;
            assigned_to_id: string | null;
            contact_name: string | null;
            contact_phone: string | null;
          }>;
          if (leadArr.length === 0) {
            throw new Error(`transfer-trigger: lead ${leadId} not found`);
          }
          leadSnapshot = {
            eventType: leadArr[0].event_type,
            eventDate: leadArr[0].event_date,
            guestCount: leadArr[0].guest_count,
            assignedToId: leadArr[0].assigned_to_id,
            contactName: leadArr[0].contact_name,
            contactPhone: leadArr[0].contact_phone,
          };

          // Passo 1.
          // Bloco 3: além de is_human_active, persiste interest_summary e
          // suggested_action quando o Claude os passou via tool args. Se forem
          // null, NÃO sobrescrevemos o que já estava no lead (preserva
          // snapshot de um handoff anterior caso este seja segundo handoff).
          await tx.execute(sql`
            UPDATE leads SET
              is_human_active  = true,
              interest_summary = COALESCE(${interestSummary}, interest_summary),
              suggested_action = COALESCE(${suggestedAction}, suggested_action)
            WHERE id = ${leadId}
          `);

          // Passo 3 — INSERT tasks.
          // Bloco 9: popula `assigned_to_phone` com o `support_whatsapp` da
          // config ativa para o webhook handler (Bloco 9 task #39) conseguir
          // resolver lead a partir do número emissor sem JOIN com `users`.
          // Coluna criada na migration 20260509000000_handoff_continuity (D5).
          // Quando `support_whatsapp` é vazio/null, persiste NULL — task ainda
          // é criada mas o detection do webhook não vincula (caso degradado
          // aceito; tasks legacy pré-Bloco-9 ficam sem vinculação automática).
          // Feature C (3.1): âncora = primeiro alvo de notificação (antes era só
          // `support_whatsapp`). Mantém a vinculação do webhook (Bloco 9) num
          // número estável; os demais alvos recebem a notificação mas não são
          // âncora de vinculação.
          const supportPhoneForTask = notificationTargets[0] ?? null;
          const taskRows = await tx.execute<{ id: string }>(sql`
            INSERT INTO tasks (
              lead_id, contact_id, title, type, priority, status,
              assigned_to_id, assigned_to_phone, created_by_id
            ) VALUES (
              ${leadId},
              ${ctx.contact.id},
              ${'Lead HOT — atendimento'},
              ${'FOLLOWUP'}::task_type,
              ${'HIGH'}::task_priority,
              ${'PENDING'}::task_status,
              ${leadSnapshot.assignedToId},
              ${supportPhoneForTask},
              NULL
            )
            RETURNING id
          `);
          const taskArr = Array.from(taskRows) as Array<{ id: string }>;
          taskId = taskArr[0]?.id ?? null;

          // Passo 5 — INSERT timeline_events (a transação fecha aqui; o emit
          // do EventBus é chamado FORA, depois do commit).
          const tlMetadata = {
            tool: 'transfer_to_human',
            classification: ctx.lead?.classification ?? null,
            reason: reason ?? null,
            event_type: leadSnapshot.eventType,
            event_date: leadSnapshot.eventDate,
            guest_count: leadSnapshot.guestCount,
            interest_summary: interestSummary,
            suggested_action: suggestedAction,
          };
          const tlRows = await tx.execute<{ id: string }>(sql`
            INSERT INTO timeline_events (
              contact_id, lead_id, type, title, description, metadata, created_by_id
            ) VALUES (
              ${ctx.contact.id},
              ${leadId},
              ${'OTHER'}::timeline_event_type,
              ${'Handoff HOT'},
              ${reason ?? null},
              ${JSON.stringify(tlMetadata)}::jsonb,
              NULL
            )
            RETURNING id
          `);
          const tlArr = Array.from(tlRows) as Array<{ id: string }>;
          timelineEventId = tlArr[0]?.id ?? null;
        });
      } catch (err) {
        // Rollback automático pela transação. Emite e re-throw para o loop
        // marcar o turno como erro top-level (evita estado inconsistente).
        const message = err instanceof Error ? err.message : String(err);
        ctx.eventBus.emit(
          'handoff_db_failed',
          { message, lead_id: leadId },
          'high',
        );
        throw err;
      }

      // ─── Passo 2 — send mensagem de transição ao cliente ──────────────
      // Bypassa response-guard (INVARIANTE 5).
      let clientSent = false;
      try {
        await client.send({
          recipientId: ctx.payload.data.sender.id,
          recipientType: ctx.payload.data.recipient.type,
          text: transferMessage,
        });
        clientSent = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.eventBus.emit(
          'handoff_partial',
          {
            step: 'send_client',
            message,
            lead_id: leadId,
          },
          'high',
        );
      }

      // ─── Passo 4 — send notificação ao Juliano (template humanizado) ──
      // Bloco 3: usa `agent_configs.hook_params.handoff_support_message_template`
      // interpolado via `interpolateTemplate`. Se ausente, fallback para texto
      // legacy hardcoded (preserva comportamento de v2).
      let supportTextRendered = '';
      let supportTemplateUsed: 'configured' | 'legacy_fallback' | 'skipped' =
        'skipped';
      let supportSentCount = 0;
      const supportFailedTargets: string[] = [];

      if (notificationTargets.length === 0) {
        ctx.eventBus.emit(
          'handoff_notification_targets_empty',
          {
            lead_id: leadId,
            reason:
              'notification_targets e support_whatsapp ambos vazios — nenhuma notificação enviada',
          },
          'med',
        );
      } else {
        // Buscar preference_visit em contact_facts FORA da transação (a
        // transação já commitou; leitura paralela ao send do cliente seria
        // ideal, mas trade-off pequeno e mantém código sequencial simples).
        let preferenceVisit: string | null = null;
        try {
          preferenceVisit = await fetchPreferenceVisit(ctx.contact.id);
        } catch (err) {
          // Falha ao buscar fact não pode quebrar o handoff. Loga e segue
          // com '—' no template.
          const message = err instanceof Error ? err.message : String(err);
          ctx.eventBus.emit(
            'handoff_facts_lookup_failed',
            { lead_id: leadId, contact_id: ctx.contact.id, message },
            'med',
          );
        }

        const guestCountStr =
          leadSnapshot.guestCount != null
            ? `${leadSnapshot.guestCount} pessoas`
            : '—';

        const vars = {
          nome: leadSnapshot.contactName ?? ctx.contact.name ?? '—',
          whatsapp: formatPhone(
            leadSnapshot.contactPhone ?? ctx.contact.phone ?? null,
          ),
          evento: humanizeEventType(leadSnapshot.eventType),
          // ISO YYYY-MM-DD → BR DD/MM/YYYY via heurística do template helper
          // (key 'data' bate em isDateKeyByName).
          data: leadSnapshot.eventDate,
          convidados: guestCountStr,
          preferencia: preferenceVisit,
          interesse: interestSummary,
          acao_sugerida: suggestedAction,
        };

        if (supportTemplate && supportTemplate.trim() !== '') {
          supportTextRendered = interpolateTemplate(supportTemplate, vars);
          supportTemplateUsed = 'configured';
        } else {
          // Fallback legacy: texto v2 minimamente informativo.
          ctx.eventBus.emit(
            'handoff_template_missing',
            {
              lead_id: leadId,
              reason:
                'hook_params.handoff_support_message_template ausente — usando fallback legacy',
            },
            'info',
          );
          supportTextRendered =
            `Lead HOT: ${vars.nome}, ` +
            `evento: ${vars.evento}, ` +
            `data: ${vars.data ?? '—'}, ` +
            `convidados: ${vars.convidados}\n` +
            `Motivo: ${reason ?? '—'}`;
          supportTemplateUsed = 'legacy_fallback';
        }

        // Feature C (3.1) — loop de send: mesmo texto para todos os alvos.
        // Falha em um alvo NÃO impede os demais (cada um com seu try/catch).
        for (const target of notificationTargets) {
          try {
            await client.send({
              recipientId: target,
              recipientType: 'chat',
              text: supportTextRendered,
            });
            supportSentCount += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            supportFailedTargets.push(target);
            ctx.eventBus.emit(
              'handoff_partial',
              {
                step: 'send_support',
                target_redacted: redactPhone(target),
                message,
                lead_id: leadId,
              },
              'high',
            );
          }
        }
      }

      // Emit final.
      ctx.eventBus.emit(
        'handoff_complete',
        {
          lead_id: leadId,
          contact_id: ctx.contact.id,
          task_id: taskId,
          timeline_event_id: timelineEventId,
          client_sent: clientSent,
          support_sent: supportSentCount > 0,
          support_sent_count: supportSentCount,
          notification_targets_count: notificationTargets.length,
          notification_targets_source: notificationTargetsSource,
          support_failed_count: supportFailedTargets.length,
          support_template_used: supportTemplateUsed,
          interest_summary_set: interestSummary != null,
          suggested_action_set: suggestedAction != null,
          reason: reason ?? null,
        },
        'info',
      );

      // Short-circuit do AFTER_MODEL — format-whatsapp NÃO roda neste turno.
      // E o restante do loop (INSERT outbound + BEFORE_SEND + send) também é
      // pulado pela mecânica do shortCircuit no `loop.ts`.
      return { shortCircuit: true };
    },
  };
}
