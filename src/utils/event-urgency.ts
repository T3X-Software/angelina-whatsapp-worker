// src/utils/event-urgency.ts
//
// Feature 1.6 (ADR 0001) — proximidade do evento DERIVADA de `event_date`.
// Função PURA (sem IO, sem `new Date()` interno — o composer passa o "hoje").
// Faixas configuráveis em `hook_params.event_urgency.thresholds_days`.

export type EventUrgency = 'IMEDIATO' | 'PROXIMO' | 'PLANEJADO';

export interface UrgencyThresholds {
  imediato: number;
  proximo: number;
}

/** Default seguro (dias). Janelas apertadas: ≤7 IMEDIATO, ≤30 PROXIMO. */
export const DEFAULT_URGENCY_THRESHOLDS: UrgencyThresholds = {
  imediato: 7,
  proximo: 30,
};

/**
 * Resolve os thresholds da config (JSONB, pode vir malformado). Cada campo cai
 * para o default se não for número > 0.
 */
export function resolveUrgencyThresholds(raw: unknown): UrgencyThresholds {
  const t =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const imediato =
    typeof t.imediato === 'number' && t.imediato > 0
      ? t.imediato
      : DEFAULT_URGENCY_THRESHOLDS.imediato;
  const proximo =
    typeof t.proximo === 'number' && t.proximo > 0
      ? t.proximo
      : DEFAULT_URGENCY_THRESHOLDS.proximo;
  return { imediato, proximo };
}

/**
 * Dias inteiros entre `today` e `eventDate` (eventDate − today). Ambos no
 * formato ISO `YYYY-MM-DD` (slice defensivo se vier com horário). `null` se
 * qualquer um for inválido.
 */
export function daysUntil(
  eventDateISO: string,
  todayISO: string,
): number | null {
  const ev = Date.parse(`${eventDateISO.slice(0, 10)}T00:00:00Z`);
  const td = Date.parse(`${todayISO.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ev) || Number.isNaN(td)) return null;
  return Math.round((ev - td) / 86_400_000);
}

/**
 * Deriva a urgência do evento. Retorna `null` quando NÃO deve injetar:
 *   - sem `event_date`;
 *   - data inválida;
 *   - data no passado (lead velho / erro — não faz sentido marcar urgência).
 *
 * Caso contrário: `≤imediato → IMEDIATO`, `≤proximo → PROXIMO`, senão `PLANEJADO`.
 */
export function deriveEventUrgency(
  eventDateISO: string | null | undefined,
  todayISO: string,
  thresholds: UrgencyThresholds,
): EventUrgency | null {
  if (!eventDateISO) return null;
  const days = daysUntil(eventDateISO, todayISO);
  if (days === null || days < 0) return null;
  if (days <= thresholds.imediato) return 'IMEDIATO';
  if (days <= thresholds.proximo) return 'PROXIMO';
  return 'PLANEJADO';
}
