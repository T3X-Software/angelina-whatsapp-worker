// src/utils/blocked-dates.ts
//
// Feature 1.11 — helpers PUROS da tool `check_blocked_dates`. Sem IO (não
// importa db) para ser testável por um smoke simples. A query fica na tool.

export interface BlockedDatesRangeInput {
  date?: string;
  start_date?: string;
  end_date?: string;
}

export type ResolvedRange = { start: string; end: string } | { error: string };

/**
 * Resolve o intervalo a consultar a partir do input:
 *   - `date` → dia único [date, date].
 *   - `start_date` (com `end_date` opcional) → [start, end ?? start].
 *   - nenhum → erro (LLM deve informar uma data).
 *
 * Defensivo: se `end_date` < `start_date`, normaliza invertendo (a tool não
 * deve falhar por ordem trocada).
 */
export function resolveBlockedDatesRange(
  input: BlockedDatesRangeInput,
): ResolvedRange {
  if (input.date) return { start: input.date, end: input.date };
  if (input.start_date) {
    const end = input.end_date ?? input.start_date;
    return input.start_date <= end
      ? { start: input.start_date, end }
      : { start: end, end: input.start_date };
  }
  return { error: 'informe `date` (dia único) ou `start_date` (intervalo)' };
}

/** Normaliza `time` do Postgres (`16:09:00`) para `HH:MM`. `null` → `null`. */
export function toHHMM(t: string | null | undefined): string | null {
  return t == null ? null : t.slice(0, 5);
}

// `type` (não `interface`) de propósito: precisa satisfazer o constraint
// `Record<string, unknown>` do genérico de `db.execute<T>`.
export type BlockedDateRow = {
  date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
};

export interface BlockedDateEntry {
  date: string;
  full_day: boolean;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
}

/** Mapeia uma linha crua de `blocked_dates` para a saída da tool. */
export function mapBlockedRow(row: BlockedDateRow): BlockedDateEntry {
  return {
    date: row.date,
    full_day: row.start_time == null,
    start_time: toHHMM(row.start_time),
    end_time: toHHMM(row.end_time),
    reason: row.reason,
  };
}
