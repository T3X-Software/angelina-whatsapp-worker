// src/harness/event-bus.ts
//
// Bloco 5 — Task 26.
//
// EventBus PER-TURN (NÃO global). `createEventBus(...)` retorna uma nova
// instância por chamada — cada `loop.run` cria a sua. Isto evita
// vazamento de eventos entre turnos paralelos (concurrency 5 do Worker).
//
// Implementação:
//   - Acumula `TraceEvent[]` em memória durante o turno.
//   - `flushToDatabase()` faz **1 round-trip** com `db.insert(traces).values([...])`.
//   - Idempotente: chamadas extras após o primeiro flush são no-op.
//   - Erros no flush são LOGADOS (console.error), NUNCA propagados —
//     traces falharem não deve derrubar o turno (resposta já foi enviada).
//
// Mapeamento para a tabela real `public.traces` (decisão 22:42 no log):
//   - `severity` NÃO existe como coluna — vai dentro de `payload.severity`.
//   - `messageId` (uuid FK → messages.id) é a âncora do turno
//     (substitui o `turn_id` mencionado no brief).
//   - `created_at` tem default now() — não preenchemos client-side.

import { db } from '../db/client';
import { traces } from '../db/schema';
import type {
  EventBus,
  HookPhase,
  TraceEvent,
  TraceSeverity,
  TurnId,
} from './types';

/**
 * Construtor da instância per-turn.
 *
 * @param turnId       Placeholder antes do `claimMessage`. Após o INSERT inbound,
 *                     `bindMessageId()` substitui pelo uuid real do `messages.id`.
 * @param contactId    UUID do contato resolvido (Bloco 4).
 * @param leadId       UUID do lead ativo (ou null se contact sem lead).
 *
 * Note que `turnId` em si não vai para o banco — a coluna real é
 * `traces.message_id`. O parâmetro existe só para casos onde quisermos
 * referenciar logicamente o turno antes de termos o messageId persistido.
 */
export function createEventBus(
  turnId: TurnId,
  contactId: string,
  leadId: string | null,
): EventBus {
  const events: TraceEvent[] = [];
  let flushed = false;
  let messageId: string | null = null;

  // Suprime "unused" do TS sem perder o sinal — turnId é informativo
  // (logado em error-paths) mas não persiste.
  void turnId;

  function emit(
    eventType: string,
    payload: Record<string, unknown> = {},
    severity: TraceSeverity = 'info',
  ): void {
    if (flushed) {
      // Após flush, eventos novos são silenciosamente descartados.
      // Em prod, isto seria warn/log; mantemos quieto para não poluir.
      return;
    }
    events.push({
      eventType,
      payload: { ...payload, severity },
      messageId,
      contactId,
      leadId,
    });
  }

  function emitHook(
    hookName: string,
    phase: HookPhase,
    payload: Record<string, unknown> = {},
    severity: TraceSeverity = 'info',
  ): void {
    if (flushed) return;
    events.push({
      eventType: `hook_${hookName}`,
      payload: { ...payload, severity },
      messageId,
      contactId,
      leadId,
      phase,
      hookName,
    });
  }

  function emitTool(
    toolName: string,
    eventType: string,
    payload: Record<string, unknown> = {},
    severity: TraceSeverity = 'info',
  ): void {
    if (flushed) return;
    events.push({
      eventType,
      payload: { ...payload, severity },
      messageId,
      contactId,
      leadId,
      toolName,
    });
  }

  function bindMessageId(newMessageId: string): void {
    messageId = newMessageId;
    // Atualiza retroativamente eventos que ainda não tinham messageId.
    // Aceitável porque tudo está em memória até o flush.
    for (const ev of events) {
      if (ev.messageId === null) {
        ev.messageId = newMessageId;
      }
    }
  }

  async function flushToDatabase(): Promise<{ inserted: number }> {
    if (flushed) {
      return { inserted: 0 };
    }
    flushed = true;
    if (events.length === 0) {
      return { inserted: 0 };
    }
    try {
      const rows = events.map((ev) => ({
        eventType: ev.eventType,
        messageId: ev.messageId,
        contactId: ev.contactId,
        leadId: ev.leadId,
        phase: ev.phase ?? null,
        hookName: ev.hookName ?? null,
        toolName: ev.toolName ?? null,
        latencyMs: ev.latencyMs ?? null,
        payload: ev.payload,
        error: ev.error ?? null,
      }));
      await db.insert(traces).values(rows);
      return { inserted: rows.length };
    } catch (err) {
      // NUNCA propaga — o turno do usuário já terminou (ou está terminando).
      // Logar para Loki/Pino e seguir.

      console.error(
        '[event-bus] flushToDatabase failed (silenced)',
        err instanceof Error ? err.message : String(err),
      );
      return { inserted: 0 };
    }
  }

  return {
    emit,
    emitHook,
    emitTool,
    bindMessageId,
    flushToDatabase,
    get events() {
      return events as ReadonlyArray<TraceEvent>;
    },
  };
}
