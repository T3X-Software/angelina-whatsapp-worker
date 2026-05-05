// src/hooks/index.ts
//
// Bloco 6 — Task 31. Pipeline de hooks (concept `hook-pipeline`).
//
// ⚠️ ORDEM IMUTÁVEL — viola invariantes 1+2 da CLAUDE.md raiz se mudar:
//   - INVARIANTE 1 (response-guard SEMPRE último em BEFORE_SEND)
//   - INVARIANTE 2 (rate-limit-guard SEMPRE primeiro em BEFORE_REQUEST)
// Não mudar a ordem dos arrays abaixo sem PR explícito + revisão de invariantes.
//
// Como `transfer-trigger` e `human-delay` precisam do `ZapsterClient` (o
// transfer faz 2 sends bypassando response-guard — única exceção autorizada
// invariante 5; o human-delay dispara typing indicator best-effort), expomos
// também uma factory `buildHookPipeline(client)` que devolve as 3 fases
// já compostas. Hooks que NÃO precisam de cliente (rate-limit-guard,
// admin-router, load-context-and-summary, format-whatsapp, response-guard)
// continuam como singletons exportados.

import type { Hook } from '../harness/types';
import type { ZapsterClient } from '../zapster/client';

import { rateLimitGuard } from './rate-limit-guard';
import { adminRouter } from './admin-router';
import { loadContextAndSummary } from './load-context-and-summary';
import { formatWhatsapp } from './format-whatsapp';
import { responseGuard } from './response-guard';
import { createTransferTriggerHook } from './transfer-trigger';
import { createHumanDelayHook } from './human-delay';

// Re-exports individuais (úteis para testes unitários e smokes).
export { rateLimitGuard } from './rate-limit-guard';
export { adminRouter } from './admin-router';
export { loadContextAndSummary } from './load-context-and-summary';
export { formatWhatsapp, formatWhatsappText } from './format-whatsapp';
export { responseGuard } from './response-guard';
export { createTransferTriggerHook } from './transfer-trigger';
export { createHumanDelayHook, computeHumanDelayMs } from './human-delay';

/**
 * BEFORE_REQUEST — ordem imutável (INVARIANTE 2: rate-limit-guard PRIMEIRO).
 * Hooks deste array NÃO precisam de injeção de ZapsterClient.
 */
export const BEFORE_REQUEST_HOOKS: ReadonlyArray<Hook> = [
  rateLimitGuard,
  adminRouter,
  loadContextAndSummary,
] as const;

/**
 * Pipeline factory — entrega as 3 fases já compostas com hooks reais
 * (incluindo os que dependem de ZapsterClient). É o que o `loop.ts` consome.
 *
 * Decisão: o loop pode chamar `buildHookPipeline(client)` UMA vez ao iniciar
 * (fora de `run()`) ou a cada turno. Como Hook objects são imutáveis e o
 * client é singleton, basta uma vez por boot — a factory é barata.
 */
export function buildHookPipeline(client: ZapsterClient): {
  BEFORE_REQUEST: ReadonlyArray<Hook>;
  AFTER_MODEL: ReadonlyArray<Hook>;
  BEFORE_SEND: ReadonlyArray<Hook>;
} {
  // AFTER_MODEL — ordem: transfer-trigger PRIMEIRO (HOT handoff), depois
  // format-whatsapp. Se transfer fizer short-circuit, format NÃO roda — é o
  // comportamento desejado (não há resposta a formatar).
  const AFTER_MODEL: ReadonlyArray<Hook> = [
    createTransferTriggerHook(client),
    formatWhatsapp,
  ] as const;

  // BEFORE_SEND — ordem: human-delay PRIMEIRO, response-guard ÚLTIMO
  // (INVARIANTE 1). Não inserir nada após response-guard.
  const BEFORE_SEND: ReadonlyArray<Hook> = [
    createHumanDelayHook(client),
    responseGuard,
  ] as const;

  return {
    BEFORE_REQUEST: BEFORE_REQUEST_HOOKS,
    AFTER_MODEL,
    BEFORE_SEND,
  };
}
