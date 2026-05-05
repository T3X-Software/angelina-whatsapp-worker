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
//   1. UPDATE leads SET is_human_active=true WHERE id=$1
//   2. ZapsterClient.send(transferMessage)            ← bypassa response-guard
//   3. INSERT INTO tasks ('Lead HOT — atendimento', FOLLOWUP, HIGH, PENDING)
//   4. ZapsterClient.send(messageJuliano)             ← support_whatsapp
//   5. INSERT INTO timeline_events ('Handoff HOT', OTHER) + emit handoff_complete
//
// Atomicidade: 1+3+5 ficam em transação Drizzle (passos de banco). 2+4 (sends)
// rodam fora da transação — não dá rollback de mensagem enviada. Estratégia:
//   1. abre transação
//   2. UPDATE is_human_active=true
//   3. INSERT tasks
//   4. INSERT timeline_events
//   5. commit
//   6. send 2 (cliente)
//   7. send 4 (Juliano) — se support_whatsapp não vazio
// Se 6 ou 7 falham, NÃO revertemos (Sergio confirma; emite warn `handoff_partial`).
//
// Edge case `support_whatsapp=''` (Bloco 1 deixou em branco até Bloco 13):
//   - Emite warn `support_whatsapp_unset`. NÃO envia para Juliano (passo 4).
//   - Demais passos (1, 2 cliente, 3, 5) acontecem normalmente.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { Hook, HookResult, HarnessContext } from '../harness/types';
import type { ZapsterClient } from '../zapster/client';

interface HookParamsShape {
  transfer_message?: string;
}

const DEFAULT_TRANSFER_MESSAGE =
  'Perfeito, vou te conectar com um especialista agora 👌';

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
      const params = (ctx.config?.hookParams ?? {}) as HookParamsShape;
      const transferMessage =
        params.transfer_message ?? DEFAULT_TRANSFER_MESSAGE;
      const supportWhatsapp = ctx.config?.supportWhatsapp ?? '';

      // ─── Passos 1, 3, 5 em transação ───────────────────────────────────
      let taskId: string | null = null;
      let timelineEventId: string | null = null;
      let leadSnapshot: {
        eventType: string | null;
        eventDate: string | null;
        guestCount: number | null;
        assignedToId: string | null;
        contactName: string | null;
      } = {
        eventType: null,
        eventDate: null,
        guestCount: null,
        assignedToId: null,
        contactName: null,
      };

      try {
        await db.transaction(async (tx) => {
          // Snapshot do lead para a notificação ao Juliano e para o metadata.
          const leadRows = await tx.execute<{
            event_type: string | null;
            event_date: string | null;
            guest_count: number | null;
            assigned_to_id: string | null;
            contact_name: string | null;
          }>(sql`
            SELECT l.event_type::text       AS event_type,
                   l.event_date::text       AS event_date,
                   l.guest_count            AS guest_count,
                   l.assigned_to_id         AS assigned_to_id,
                   c.name                   AS contact_name
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
          };

          // Passo 1.
          await tx.execute(sql`
            UPDATE leads SET is_human_active = true WHERE id = ${leadId}
          `);

          // Passo 3 — INSERT tasks.
          const taskRows = await tx.execute<{ id: string }>(sql`
            INSERT INTO tasks (
              lead_id, contact_id, title, type, priority, status,
              assigned_to_id, created_by_id
            ) VALUES (
              ${leadId},
              ${ctx.contact.id},
              ${'Lead HOT — atendimento'},
              ${'FOLLOWUP'}::task_type,
              ${'HIGH'}::task_priority,
              ${'PENDING'}::task_status,
              ${leadSnapshot.assignedToId},
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

      // ─── Passo 4 — send notificação ao Juliano ────────────────────────
      let supportSent = false;
      if (!supportWhatsapp || supportWhatsapp.trim() === '') {
        ctx.eventBus.emit(
          'support_whatsapp_unset',
          {
            lead_id: leadId,
            reason:
              'agent_configs.support_whatsapp is empty — skipping support notification',
          },
          'med',
        );
      } else {
        const recipientLabel =
          leadSnapshot.contactName ?? ctx.contact.phone ?? 'Contato';
        const supportText =
          `Lead HOT: ${recipientLabel}, ` +
          `evento: ${leadSnapshot.eventType ?? '—'}, ` +
          `data: ${leadSnapshot.eventDate ?? '—'}, ` +
          `convidados: ${leadSnapshot.guestCount ?? '—'}\n` +
          `Motivo: ${reason ?? '—'}`;
        try {
          await client.send({
            recipientId: supportWhatsapp,
            recipientType: 'chat',
            text: supportText,
          });
          supportSent = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.eventBus.emit(
            'handoff_partial',
            {
              step: 'send_support',
              message,
              lead_id: leadId,
            },
            'high',
          );
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
          support_sent: supportSent,
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
