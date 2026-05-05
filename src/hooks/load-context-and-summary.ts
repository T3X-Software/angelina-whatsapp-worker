// src/hooks/load-context-and-summary.ts
//
// Bloco 6 — Task 34. ÚLTIMO hook de BEFORE_REQUEST.
// Bloco 10 — Task 53: STUB removido, agora chama `compose(ctx)` real.
//
// Hook "passivo" — não decide nada nem short-circuita. Popula `ctx.memory`
// (L1 + L2 + system pré-montado) para que o LLM call subsequente já receba
// a memória composta sem precisar refazer trabalho.
//
// O loop (`src/harness/loop.ts`) prefere `ctx.memory.system` quando setado —
// caso contrário cai no `ctx.config.systemPrompt` puro (path antigo, mantido
// como fallback defensivo).

import type { Hook, HookResult, HarnessContext } from '../harness/types';
import { compose } from '../memory/composer';

export const loadContextAndSummary: Hook = {
  name: 'load-context-and-summary',
  phase: 'BEFORE_REQUEST',

  async run(ctx: HarnessContext): Promise<HookResult> {
    // Sem config: nada a compor (loop não chega a chamar LLM nesse caso).
    if (ctx.config === null) {
      ctx.memory = { l1: [], l2: '' };
      ctx.eventBus.emit(
        'memory_loaded',
        { skipped: true, reason: 'no_config' },
        'info',
      );
      return {};
    }

    const composed = await compose(ctx);

    ctx.memory = {
      l1: composed.messages,
      l2: composed.l2,
      system: composed.system,
      tokenEstimate: composed.tokenEstimate,
    };

    ctx.eventBus.emit(
      'memory_loaded',
      {
        n_l1: composed.l1Count,
        l2_chars: composed.l2Chars,
        system_chars: composed.systemChars,
        token_estimate: composed.tokenEstimate,
      },
      'info',
    );

    return {};
  },
};
