// src/harness/tracer.ts
//
// Bloco 5 — Task 27.
//
// Helpers que envolvem funções (sync e async) emitindo no EventBus dois
// eventos: `<eventType>_start` (opcional) e `<eventType>_end` com
// `latency_ms` calculado via `performance.now()`. Permite que hooks/tools/LLM
// recebam tracing uniforme sem boilerplate.
//
// Decisão (mesma do Bloco 4 STUB consumer): emitimos APENAS o `_end` com
// `latency_ms` — `_start` separado dobra o número de rows e raramente
// adiciona valor (timestamp do `_end - latency` reconstrói).

import { performance } from 'node:perf_hooks';

import type { EventBus, TraceSeverity } from './types';

/**
 * Wrap async function. Emite `<eventType>_end` com `latency_ms` + status `ok`.
 *
 * Em caso de erro, propaga após emitir `<eventType>_end` com `ok=false` e
 * a mensagem da exceção em `payload.error` (severity 'med' por padrão; o
 * caller pode optar por re-emitir 'high' acima depois de re-throw).
 */
export async function traced<T>(
  bus: EventBus,
  eventType: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    bus.emit(
      `${eventType}_end`,
      {
        ...fields,
        latency_ms: Math.round(performance.now() - start),
        ok: true,
      },
      'info',
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bus.emit(
      `${eventType}_end`,
      {
        ...fields,
        latency_ms: Math.round(performance.now() - start),
        ok: false,
        error: message,
      },
      'med',
    );
    throw err;
  }
}

/**
 * Versão síncrona — útil para hooks puros (string transforms, validações)
 * que não fazem I/O mas queremos medir mesmo assim.
 */
export function tracedSync<T>(
  bus: EventBus,
  eventType: string,
  fields: Record<string, unknown>,
  fn: () => T,
  severityOnError: TraceSeverity = 'med',
): T {
  const start = performance.now();
  try {
    const result = fn();
    bus.emit(
      `${eventType}_end`,
      {
        ...fields,
        latency_ms: Math.round(performance.now() - start),
        ok: true,
      },
      'info',
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bus.emit(
      `${eventType}_end`,
      {
        ...fields,
        latency_ms: Math.round(performance.now() - start),
        ok: false,
        error: message,
      },
      severityOnError,
    );
    throw err;
  }
}
