// src/utils/template.ts
//
// Bloco 2 — Task 7 da feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Helper puro de interpolação de templates `{{var}}` reusável. Sem dependência
// externa (sem Mustache/Handlebars). Usado pelo `transfer-trigger` (Bloco 3)
// para gerar a mensagem humanizada ao support_whatsapp a partir do template
// `agent_configs.hook_params.handoff_support_message_template`.
//
// Decisão (5.3 do plan + Bloco 1): variável ausente OR null/undefined renderiza
// como `'—'` (em-dash). Sem `.path.nested` no MVP — apenas keys top-level.
//
// Auto-conversão de data BR (decisão 5.2 do plan):
//   - Se key matches heurística de data (nome inclui 'data', 'date', 'event_date')
//     E valor é string `^\d{4}-\d{2}-\d{2}$` → converter para `DD/MM/YYYY`.
//   - Se valor é Date object → ISO yyyy-mm-dd → DD/MM/YYYY.
//   - Caso contrário, deixa como está (toString).
//
// Pattern de match: `/\{\{\s*([\w.]+)\s*\}\}/g` — suporta `{{nome}}` e `{{ nome }}`,
// keys com letras/dígitos/underscore/ponto. Se há ponto na chave, lookup ainda é
// flat (`vars['lead.evento']` direto, sem walk em sub-objetos no MVP).

export type TemplateVars = Record<string, unknown>;

export interface InterpolateOptions {
  /**
   * Lista explícita de keys que devem ser tratadas como data e auto-convertidas.
   * Default: heurística por nome — `data`, `date` exatos OU contém `_date`/`date_`.
   * Útil para sobrescrever em testes ou em domínios com convenção própria.
   */
  dateKeys?: string[];
  /** Placeholder para variáveis ausentes/null/undefined. Default: `'—'`. */
  missingPlaceholder?: string;
}

const TEMPLATE_REGEX = /\{\{\s*([\w.]+)\s*\}\}/g;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Heurística default — reconhece como "data" qualquer key que:
 *   - seja literalmente 'data' ou 'date' (case-insensitive); OU
 *   - contenha 'date' como sub-string (ex: 'event_date', 'dateOfBirth'); OU
 *   - contenha 'data_' ou '_data' (ex: 'data_evento', 'evento_data').
 */
function isDateKeyByName(key: string, explicit?: string[]): boolean {
  if (explicit && explicit.includes(key)) return true;
  const lower = key.toLowerCase();
  if (lower === 'data' || lower === 'date') return true;
  if (lower.includes('date')) return true;
  if (lower.includes('data_') || lower.includes('_data')) return true;
  return false;
}

/**
 * Converte `YYYY-MM-DD` → `DD/MM/YYYY`. Retorna a string original se não
 * matchar o formato ISO básico.
 */
function isoToBrDate(iso: string): string {
  if (!ISO_DATE_REGEX.test(iso)) return iso;
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Converte um valor heterogêneo em string para interpolação:
 *   - undefined/null → placeholder
 *   - Date → ISO date (yyyy-mm-dd) e, se key for date, → BR
 *   - string ISO date e key for date → BR
 *   - resto: String(value)
 */
function renderValue(
  key: string,
  value: unknown,
  isDateKey: boolean,
  missing: string,
): string {
  if (value === undefined || value === null) return missing;

  // Date object — sempre converte para ISO (UTC) e, se for key de data, BR.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return missing;
    const iso = value.toISOString().slice(0, 10);
    return isDateKey ? isoToBrDate(iso) : iso;
  }

  if (typeof value === 'string') {
    if (isDateKey && ISO_DATE_REGEX.test(value)) return isoToBrDate(value);
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  // Objetos/arrays — JSON puro. Não esperado no MVP, mas defensivo.
  try {
    return JSON.stringify(value);
  } catch {
    return missing;
  }
}

/**
 * Interpola `{{var}}` em `template` usando `vars`. Variáveis ausentes ou nulas
 * viram `missingPlaceholder` (default `'—'`). Auto-converte ISO date para
 * `DD/MM/YYYY` quando a key é heuristicamente reconhecida como data.
 *
 * Função pura — sem efeitos colaterais, sem I/O. Sem chamada a LLM
 * (invariante #3). Sem envio (invariante #4).
 */
export function interpolateTemplate(
  template: string,
  vars: TemplateVars,
  options: InterpolateOptions = {},
): string {
  const missing = options.missingPlaceholder ?? '—';
  const explicitDateKeys = options.dateKeys;

  return template.replace(TEMPLATE_REGEX, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const value = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
    const isDate = isDateKeyByName(key, explicitDateKeys);
    return renderValue(key, value, isDate, missing);
  });
}
