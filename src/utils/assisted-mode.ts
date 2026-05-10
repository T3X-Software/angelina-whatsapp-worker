// src/utils/assisted-mode.ts
//
// Bloco 6 — feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Helper compartilhado para classificar o estado de handoff de um lead a partir
// de uma única SELECT em `leads`. Usado pelas tools (tool-gating) e
// potencialmente pelo response-guard (Bloco 4 leu inline; aqui consolidamos a
// semântica em um lugar só para reuso futuro).
//
// Contratos:
//   - Função PURA do ponto de vista de I/O semântico — recebe leadId, retorna
//     estado discriminado. Internamente faz 1 SELECT por chamada (sem cache).
//     As tools que precisam disso só rodam 1×/turno cada, então o custo é
//     desprezível (≤1 round-trip por chamada de tool).
//   - Quando lead não existe (delete em race com tool dispatch), retorna
//     `{ mode: 'free' }` — defensive default. O response-guard (BEFORE_SEND)
//     vai checar de novo de qualquer forma; tool-gating é a 3ª camada.
//
// 3 estados (concept `ai-state-control`, atualizado por esta feature):
//   - free: is_human_active=false. IA opera normalmente.
//   - assisted: is_human_active=true && handoff_assumed_at IS NULL.
//                Handoff foi disparado mas humano ainda não assumiu.
//                Modo "tutela" — IA continua falando, mas alguns canais
//                ficam restritos (response-guard substitui mensagens
//                sensíveis; tools de handoff/escalação retornam erro).
//   - blocked: is_human_active=true && handoff_assumed_at NOT NULL.
//                Humano confirmou. IA fica 100% muda — response-guard
//                bloqueia tudo.
//
// Por que NÃO ler de `ctx.lead`?
//   `ctx.lead` é hidratado no início do turno e tem `isHumanActive` mas NÃO
//   tem `handoff_assumed_at`. Adicionar lá exigiria estender o loader e
//   inflar o ctx. A query aqui é targetada (1 row, 2 colunas) e não cria
//   acoplamento — outras tools/hooks que precisem do estado podem reusar.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';

/**
 * Estado discriminado do handoff de um lead.
 * `mode` é a chave única — o valor de `assumedAt` é redundante mas útil
 * para logs/observabilidade quando `mode === 'blocked'`.
 */
export type LeadHandoffState =
  | { mode: 'free' }
  | { mode: 'assisted'; assumedAt: null }
  | { mode: 'blocked'; assumedAt: Date | string };

interface LeadHandoffRow {
  is_human_active: boolean | null;
  handoff_assumed_at: Date | string | null;
  // Index signature exigido pelo tipo do `db.execute<T>` (Drizzle constraint
  // `Record<string, unknown>`). Mantemos as 2 colunas reais como tipos
  // específicos; outras colunas eventuais (defensive) caem em unknown.
  [key: string]: unknown;
}

/**
 * Lê estado atual do handoff de um lead (1 SELECT targetado).
 *
 * Quando `leadId` é null ou o lead não é encontrado, retorna `{ mode: 'free' }`
 * — evita falsos positivos de gating em race conditions (ex: lead deletado
 * entre o início do turno e o dispatch da tool).
 */
export async function getLeadHandoffState(
  leadId: string | null | undefined,
): Promise<LeadHandoffState> {
  if (!leadId) return { mode: 'free' };

  const rows = await db.execute<LeadHandoffRow>(sql`
    SELECT COALESCE(is_human_active, false) AS is_human_active,
           handoff_assumed_at               AS handoff_assumed_at
      FROM leads
     WHERE id = ${leadId}
     LIMIT 1
  `);

  const arr = Array.from(rows) as LeadHandoffRow[];
  const row = arr[0];
  if (!row) return { mode: 'free' };

  if (row.is_human_active !== true) return { mode: 'free' };

  if (row.handoff_assumed_at === null || row.handoff_assumed_at === undefined) {
    return { mode: 'assisted', assumedAt: null };
  }
  return { mode: 'blocked', assumedAt: row.handoff_assumed_at };
}

/** Açúcar sintático para o caso mais comum (gate em modo assistido). */
export function isAssistedMode(state: LeadHandoffState): boolean {
  return state.mode === 'assisted';
}
