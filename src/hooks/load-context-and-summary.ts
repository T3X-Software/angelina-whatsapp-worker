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
//
// ─────────────────────────────────────────────────────────────────────────────
// Bloco 7 — feature `whatsapp-message-splitting-and-handoff-continuity`
// ─────────────────────────────────────────────────────────────────────────────
//
// Camada 1 da defesa em profundidade do modo assistido (concept `memory-layers`,
// camada L1 do system prompt). Quando o lead está em modo assistido
// (`is_human_active=true && handoff_assumed_at IS NULL`), concatenamos
// `agent_configs.hook_params.assisted_mode.addendum` ao final do system prompt
// composto pelo `compose(ctx)`.
//
// Por que append no fim (e não prepend ou seção dedicada):
//   - Recency bias: Claude tende a respeitar mais regras posicionadas perto do
//     fim do prompt. O addendum é uma DIRETRIZ ADICIONAL (restrições do modo
//     assistido), não um conteúdo nuclear — append maximiza adesão.
//   - O composer já termina com seções dinâmicas (Contato + Estado do lead).
//     O addendum entra logo após elas, mantendo coerência narrativa: estado
//     do lead → diretriz operacional condicional ao estado.
//   - Zero churn em `composer.ts` (código read-only/puro). Toda lógica
//     condicional fica concentrada aqui no hook, no ponto natural onde
//     `ctx.memory.system` é populado.
//
// Por que `getLeadHandoffState` (Bloco 6 helper) e não `ctx.lead`:
//   - `ctx.lead` tem `isHumanActive` mas NÃO tem `handoffAssumedAt`. Adicionar
//     ao loader inflaria o ctx para uso por 1 hook. Helper já consolida a
//     semântica 3-estados (free/assisted/blocked) em 1 SELECT targetado, com
//     defensive defaults idênticos aos usados em response-guard e tool-gating.
//   - Custo: +1 round-trip no BEFORE_REQUEST. Comparado ao callLLM que vem
//     em sequência (~1-3s + tokens), é desprezível.
//
// Defesa em profundidade após este bloco — 3 camadas ativas:
//   1. **Prompt addendum** (este hook) — Claude SABE de antemão que está em
//      modo assistido e quais comportamentos evitar.
//   2. **Classifier no response-guard** (Bloco 5) — substitui mensagem por
//      redirect se o LLM mesmo assim emitir conteúdo proibido.
//   3. **Tool-gating** (Bloco 6) — `transfer_to_human` retorna ok:false se
//      Claude tentar acionar transferência redundante.
//
// Invariantes preservadas:
//   - #3 (hooks não chamam LLM): apenas concatenação de strings; zero LLM.
//   - #9 (nada hardcoded): addendum vem de `agent_configs` (hot-reload 30s).

import type { Hook, HookResult, HarnessContext } from '../harness/types';
import { compose } from '../memory/composer';
import {
  getLeadHandoffState,
  isAssistedMode,
} from '../utils/assisted-mode';
import type { HandoffContinuityHookParams } from '../config/types';

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

    // Bloco 7 — Camada 1 da defesa em profundidade.
    // Detecta modo assistido (1 SELECT targetado via helper Bloco 6) e,
    // se aplicável, concatena `agent_configs.hook_params.assisted_mode.addendum`
    // ao final do system prompt composto.
    let finalSystem = composed.system;
    let assistedAddendumInjected = false;
    let addendumChars = 0;

    const leadId = ctx.lead?.id ?? null;
    if (leadId) {
      const handoffState = await getLeadHandoffState(leadId);
      if (isAssistedMode(handoffState)) {
        const hookParams =
          (ctx.config?.hookParams ?? {}) as HandoffContinuityHookParams;
        const addendum = hookParams.assisted_mode?.addendum;

        // Fallback gracioso: addendum ausente / null / string vazia / só
        // whitespace → pula injection sem crash. Defensive em todos os
        // formatos vazios (undefined, null, '', '   ').
        if (typeof addendum === 'string' && addendum.trim().length > 0) {
          finalSystem = `${composed.system}\n\n${addendum}`;
          assistedAddendumInjected = true;
          addendumChars = addendum.length;

          // Telemetria dedicada — confirma injection sem precisar dump
          // do prompt completo (que pode conter dados sensíveis do lead).
          ctx.eventBus.emit(
            'assisted_mode_addendum_injected',
            {
              contact_id: ctx.contact.id,
              lead_id: leadId,
              addendum_chars: addendumChars,
              system_chars_before: composed.system.length,
              system_chars_after: finalSystem.length,
            },
            'info',
          );
        }
      }
    }

    ctx.memory = {
      l1: composed.messages,
      l2: composed.l2,
      system: finalSystem,
      tokenEstimate: composed.tokenEstimate,
      ragActive: composed.ragActive,
    };

    ctx.eventBus.emit(
      'memory_loaded',
      {
        n_l1: composed.l1Count,
        l2_chars: composed.l2Chars,
        system_chars: finalSystem.length,
        token_estimate: composed.tokenEstimate,
        assisted_mode_addendum_injected: assistedAddendumInjected,
      },
      'info',
    );

    return {};
  },
};
