// src/hooks/media-sender.ts
//
// Feature 1.9 (ADR 0003) — hook `media-sender` (AFTER_MODEL).
//
// Envia as mídias acumuladas em `ctx.pendingMedia` (selecionadas pela tool
// `select_media`, acumuladas pelo loop). Padrão tool→hook do `transfer-trigger`:
// a tool é PURA; o hook orquestra o envio real.
//
// Invariantes / decisões (ADR 0003):
//   - INVARIANTE 5 (controlada): envia via `client.send()` direto. A mídia vem
//     de `agent_media` (curada/aprovada pelo operador), então NÃO passa pelo
//     classifier de texto do response-guard.
//   - GATE: NÃO envia se o humano assumiu (`leads.is_human_active=true` OU
//     `contacts.ai_state` PAUSED/HUMAN_TAKEOVER) — `canSendMedia`.
//   - Falha de um item não impede os demais (try/catch por mídia).
//
// Ordem (UX): roda em AFTER_MODEL, então a mídia é enviada ANTES do texto da
// resposta (que sai depois, no BEFORE_SEND). Aceito no v1; reavaliar se a UX
// pedir texto-antes-de-mídia (exigiria um passo pós-send, fora das 3 fases).

import type { Hook, HookResult, HarnessContext } from '../harness/types';
import type { ZapsterClient } from '../zapster/client';
import { canSendMedia } from '../utils/agent-media';

/** Redact de telefone para tracing: 4 primeiros + *** + 2 últimos. */
function redactPhone(p: string): string {
  return p.length <= 6 ? '***' : `${p.slice(0, 4)}***${p.slice(-2)}`;
}

export function createMediaSenderHook(client: ZapsterClient): Hook {
  return {
    name: 'media-sender',
    phase: 'AFTER_MODEL',

    async run(ctx: HarnessContext): Promise<HookResult> {
      const media = ctx.pendingMedia ?? [];
      if (media.length === 0) return {};

      // Gate: humano assumiu → não empurra mídia.
      if (!canSendMedia(ctx.lead?.isHumanActive, ctx.contact.aiState)) {
        ctx.eventBus.emit(
          'media_send_skipped',
          {
            reason: 'human_active_or_paused',
            count: media.length,
            ai_state: ctx.contact.aiState,
            is_human_active: ctx.lead?.isHumanActive ?? null,
          },
          'info',
        );
        return {};
      }

      const recipientId = ctx.payload.data.sender.id;
      const recipientType = ctx.payload.data.recipient.type;

      let sent = 0;
      const failedIds: string[] = [];
      for (const m of media) {
        try {
          await client.send({
            recipientId,
            recipientType,
            media: {
              url: m.url,
              ...(m.caption ? { caption: m.caption } : {}),
            },
          });
          sent += 1;
          ctx.eventBus.emit(
            'media_sent',
            { id: m.id, media_type: m.media_type },
            'info',
          );
        } catch (err) {
          failedIds.push(m.id);
          ctx.eventBus.emit(
            'media_send_failed',
            {
              id: m.id,
              recipient_redacted: redactPhone(recipientId),
              error: err instanceof Error ? err.message : String(err),
            },
            'high',
          );
        }
      }

      ctx.eventBus.emit(
        'media_sender_complete',
        { total: media.length, sent, failed: failedIds.length },
        'info',
      );
      return {};
    },
  };
}
