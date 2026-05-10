// src/utils/phone.ts
//
// Bloco 3 — Task 17 da feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Helper puro: converte phone em formato Zapster (sem `+`, ex `5519974131955`)
// para formato amigável BR (`+55 19 97413-1955`). Usado pelo `transfer-trigger`
// na renderização do template humanizado ao número de suporte.
//
// Convenção do projeto (memória `project_phone_format_convention`):
//   - Phones internamente são SEM `+` (formato Zapster).
//   - Prefixo de teste é `5500000XXX`.
//
// `formatPhone` é defensivo: aceita input com ou sem `+`, com/sem espaços,
// com pontuação. Strip de tudo que não for dígito antes de aplicar regra de
// formatação.
//
// Suporte:
//   - DDI 55 (Brasil) com 11 dígitos (DDD + 9 dígitos móvel) → `+55 DD 9XXXX-XXXX`
//   - DDI 55 com 10 dígitos (DDD + 8 dígitos fixo)         → `+55 DD XXXX-XXXX`
//   - Outros DDIs → fallback `+<digits>` (sem partir; cliente é raro fora BR)
//   - Vazio/null/undefined → '—' (consistente com `interpolateTemplate`)
//
// Sem dependências externas, sem I/O, sem chamada a LLM (invariantes #3 e #4).

/**
 * Formata um número em formato Zapster (`5519974131955`) para apresentação BR
 * (`+55 19 97413-1955`).
 *
 * Exemplos:
 *   formatPhone('5519974131955')  → '+55 19 97413-1955'  (móvel BR, 11 dígitos)
 *   formatPhone('551143211234')   → '+55 11 4321-1234'   (fixo BR, 10 dígitos)
 *   formatPhone('+5519974131955') → '+55 19 97413-1955'  (aceita com +)
 *   formatPhone('5500000123')     → '+55 00 0000-0123'   (prefixo teste — fixo)
 *   formatPhone('14155552671')    → '+14155552671'       (DDI ≠ 55, fallback)
 *   formatPhone(null)             → '—'
 *   formatPhone('')               → '—'
 */
export function formatPhone(e164: string | null | undefined): string {
  if (e164 === null || e164 === undefined) return '—';
  const digits = String(e164).replace(/\D/g, '');
  if (digits === '') return '—';

  // Brasil: 55 + DDD(2) + número(8 ou 9)
  if (digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);

    if (rest.length === 9) {
      // Móvel: 9XXXX-XXXX
      return `+55 ${ddd} ${rest.slice(0, 5)}-${rest.slice(5)}`;
    }
    if (rest.length === 8) {
      // Fixo: XXXX-XXXX
      return `+55 ${ddd} ${rest.slice(0, 4)}-${rest.slice(4)}`;
    }
    // DDI 55 mas formato inesperado — não tenta partir; mostra com `+55 `
    // separado para legibilidade básica.
    if (rest.length > 0) {
      return `+55 ${ddd}${rest ? ' ' + rest : ''}`;
    }
  }

  // Fallback: outros DDIs ou números muito curtos. Mantém com `+`.
  return `+${digits}`;
}
