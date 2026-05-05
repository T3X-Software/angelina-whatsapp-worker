// src/hooks/human-delay.ts
//
// Bloco 6 — Task 37. PRIMEIRO hook de BEFORE_SEND (antes de response-guard).
//
// Simula latência humana antes do envio: dorme `clamp(text.length * 5, 1000, 5000)` ms
// e dispara o typing indicator best-effort no Zapster.
//
// Não chama LLM (invariante 3). Não envia mensagem de conteúdo (invariante 4 —
// typing indicator é "metadata", não mensagem). Sempre retorna `{}` (não
// short-circuita).
//
// O `ZapsterClient` é injetado por factory para que o smoke possa instanciar
// um stub e o boot real do worker (Bloco 9) injete o real.

import type { Hook, HookResult, HarnessContext } from '../harness/types';
import type { ZapsterClient } from '../zapster/client';

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;
const MS_PER_CHAR = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeHumanDelayMs(text: string): number {
  const raw = text.length * MS_PER_CHAR;
  return Math.min(Math.max(raw, MIN_DELAY_MS), MAX_DELAY_MS);
}

export function createHumanDelayHook(client: ZapsterClient): Hook {
  return {
    name: 'human-delay',
    phase: 'BEFORE_SEND',

    async run(ctx: HarnessContext): Promise<HookResult> {
      const text = ctx.responseToSend ?? ctx.lastModelText ?? '';
      const delay = computeHumanDelayMs(text);

      // Typing indicator best-effort — silencioso em erro.
      try {
        await client.typingIndicator(ctx.payload.data.sender.id);
      } catch {
        // silent — typing é metadata, não pode quebrar o turno
      }

      await sleep(delay);

      ctx.eventBus.emit(
        'human_delay_applied',
        { ms: delay, text_len: text.length },
        'info',
      );

      return {};
    },
  };
}
