// src/utils/event-type.ts
//
// Bloco 3 — Task 16 da feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Helper puro: converte valor do enum `event_type` (PostgreSQL) em label
// PT-BR humanizado, usado pelo `transfer-trigger` ao montar a mensagem
// humanizada que chega ao número de suporte (`agent_configs.support_whatsapp`).
//
// Enum REAL no banco (verificado em `src/db/schema.ts:97-104`):
//   WEDDING, BIRTHDAY, CORPORATE, GRADUATION, SWEET_FIFTEEN, OTHER
//
// Decisão T3.4 (log 2026-05-09 15:02): cobrir literalmente os 6 valores
// do enum. Para qualquer valor fora do enum (defensivo — schema pode evoluir),
// faz capitalize do nome em vez de retornar o enum cru. null/undefined → '—'.
//
// Sem dependências externas, sem I/O, sem chamada a LLM (invariantes #3 e #4).

const EVENT_TYPE_LABELS: Record<string, string> = {
  WEDDING: 'Casamento',
  BIRTHDAY: 'Aniversário',
  CORPORATE: 'Evento Corporativo',
  GRADUATION: 'Formatura',
  SWEET_FIFTEEN: '15 anos',
  OTHER: 'Outro',
};

/**
 * Converte `event_type` (enum PG, em maiúsculas) para label PT-BR.
 *
 * Exemplos:
 *   humanizeEventType('WEDDING')        → 'Casamento'
 *   humanizeEventType('SWEET_FIFTEEN')  → '15 anos'
 *   humanizeEventType('OTHER')          → 'Outro'
 *   humanizeEventType(null)             → '—'
 *   humanizeEventType('BIRTHDAY ')      → 'Aniversário' (trim defensivo)
 *   humanizeEventType('XYZ_NEW')        → 'Xyz_new' (capitalize fallback)
 */
export function humanizeEventType(
  eventType: string | null | undefined,
): string {
  if (eventType === null || eventType === undefined) return '—';
  const trimmed = eventType.trim();
  if (trimmed === '') return '—';

  const upper = trimmed.toUpperCase();
  const label = EVENT_TYPE_LABELS[upper];
  if (label) return label;

  // Fallback: capitalize (primeira maiúscula, resto minúsculo). Evita expor
  // valor cru em maiúsculas para o operador humano.
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Lista canônica dos enum values cobertos — útil em testes. */
export const KNOWN_EVENT_TYPES: ReadonlyArray<string> =
  Object.freeze(Object.keys(EVENT_TYPE_LABELS));
