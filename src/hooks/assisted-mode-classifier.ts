// src/hooks/assisted-mode-classifier.ts
//
// Bloco 5 — Tasks 22-24 da feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Classifier de saída do LLM em MODO ASSISTIDO transitório
// (`leads.is_human_active=true && leads.handoff_assumed_at IS NULL`).
//
// Avalia a resposta gerada pelo Claude ANTES do envio. Se cair em uma das 3
// sub-categorias (`monetary`, `booking`, `duplicate_handoff`), o response-guard
// substitui a mensagem por um redirect padrão (texto neutro que devolve a
// pergunta para o humano em transição) ou silencia o envio (no caso de
// duplicate_handoff, evita o cliente receber 2 anúncios consecutivos de
// "vou te transferir").
//
// **Função PURA + módulo separado**: testável isolado. Importada pelo
// response-guard.ts. Não chama LLM (invariante #3). Não chama I/O. Não emite
// eventos diretamente (a integração no response-guard cuida do emit
// `assisted_mode_redirect` quando há match).
//
// **Cache de regex compilado** (T5.1, brief): WeakMap module-level keyed por
// objeto de config (`AssistedModeClassifier`). Quando o cache de
// `agent_configs` (TTL 30s) entrega nova config, a referência do objeto
// `classifier` muda → cache miss → recompila. WeakMap libera memória da
// config velha quando o GC roda. Não compilamos per-request.
//
// **Tolerância a regex inválido**: try/catch em `new RegExp(pattern)`. Pattern
// malformado → `compileWarnings` acumula `{ pattern, message }` e o pattern
// é descartado da lista compilada — accumulate, NÃO fail-fast. Caller pode
// inspecionar warnings via `getCompiledClassifier(config)` se quiser logar.
//
// **Precedência (T5.1 + brief)**: `duplicate_handoff > monetary > booking`.
// Primeira categoria que matchar curto-circuita avaliação das demais.
//
// **Flags regex**: `iu` (case-insensitive — "PRECO" e "preco" matcham igual;
// Unicode — caracteres acentuados como "ç", "á" funcionam).

import type {
  AssistedModeClassifier,
  AssistedModeClassifierCategory,
  AssistedModeRedirectMessages,
} from '../config/types';

/**
 * Resultado da classificação de uma mensagem em modo assistido.
 *
 * Variantes:
 *   - `category: null` → mensagem segura, libera passthrough.
 *   - `category: 'monetary' | 'booking'` → substitui pela `redirect` correspondente.
 *   - `category: 'duplicate_handoff'` → silencia (não envia ao cliente).
 *
 * Discriminated union via campo `category` — cobre os 4 cenários de forma
 * segura para o consumer (response-guard).
 */
export type ClassifierResult =
  | { category: 'monetary' | 'booking'; redirect: string }
  | { category: 'duplicate_handoff'; redirect: null; silence: true }
  | { category: null; redirect: null };

/**
 * Estrutura compilada interna — cacheada por config object.
 */
interface CompiledClassifier {
  monetary: RegExp[];
  booking: RegExp[];
  duplicate_handoff: RegExp[];
  /** Patterns que falharam ao compilar — útil para logs de boot. */
  compileWarnings: Array<{ category: string; pattern: string; message: string }>;
}

/**
 * Cache module-level. WeakMap libera memória da config velha quando o cache
 * de `agent_configs` (TTL 30s) entrega nova ref. Não usamos Map normal
 * porque objetos de config velhos ficariam retidos.
 */
const COMPILED_CACHE = new WeakMap<AssistedModeClassifier, CompiledClassifier>();

/**
 * Contador interno — usado APENAS por smokes para validar que cache invalida
 * quando a referência muda (hot-reload). Não usar em código de produção.
 */
let compilationsCount = 0;
export const _internals = {
  /** Quantas vezes `getCompiledClassifier` precisou recompilar (cache miss). */
  getCompilationsCount: (): number => compilationsCount,
  resetCompilationsCount: (): void => {
    compilationsCount = 0;
  },
};

/**
 * Compila uma lista de patterns string para `RegExp[]`. Patterns inválidos
 * são pulados (warning acumulado) — não derruba o hook (accumulate).
 */
function compilePatternList(
  patterns: string[],
  category: string,
  warnings: CompiledClassifier['compileWarnings'],
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'iu'));
    } catch (err) {
      warnings.push({
        category,
        pattern,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return compiled;
}

/**
 * Lê os patterns de uma categoria, tolerando shape parcial. Se a categoria
 * não existir ou `patterns` não for array, retorna lista vazia (defensive).
 */
function readPatterns(category: AssistedModeClassifierCategory | undefined): string[] {
  if (!category || !Array.isArray(category.patterns)) return [];
  return category.patterns;
}

/**
 * Retorna a estrutura compilada para uma config — usa cache. Em cache miss,
 * compila as 3 categorias, cacheia, e incrementa `compilationsCount`.
 *
 * **Hot-reload**: a invalidação é "natural" — quando o cache de
 * `agent_configs` entrega novo objeto, `WeakMap.get` retorna undefined e
 * recompila. Não precisa TTL local nem invalidação explícita.
 */
export function getCompiledClassifier(config: AssistedModeClassifier): CompiledClassifier {
  let compiled = COMPILED_CACHE.get(config);
  if (compiled) return compiled;

  const warnings: CompiledClassifier['compileWarnings'] = [];
  compiled = {
    monetary: compilePatternList(readPatterns(config.monetary), 'monetary', warnings),
    booking: compilePatternList(readPatterns(config.booking), 'booking', warnings),
    duplicate_handoff: compilePatternList(
      readPatterns(config.duplicate_handoff),
      'duplicate_handoff',
      warnings,
    ),
    compileWarnings: warnings,
  };

  COMPILED_CACHE.set(config, compiled);
  compilationsCount++;
  return compiled;
}

/**
 * Classifica `text` contra os patterns do classifier em modo assistido.
 *
 * **Contrato**:
 *   - `text` vazio/null/undefined → `category: null` (passthrough).
 *   - `classifier` vazio/null → `category: null` (config faltando, passthrough).
 *   - Match em `duplicate_handoff` → silence (precedência mais alta).
 *   - Match em `monetary` → redirect (precedência média).
 *   - Match em `booking` → redirect (precedência mais baixa).
 *   - Nenhum match → `category: null` (passthrough seguro).
 *
 * **Importante**: a precedência é avaliada em ordem; primeira categoria que
 * matchar retorna imediatamente. Não tenta avaliar as demais.
 *
 * @param text texto a classificar (resposta do LLM em modo assistido).
 * @param classifier objeto de patterns (geralmente
 *   `agent_configs.hook_params.assisted_mode.classifier`).
 * @param redirects mensagens de redirect por categoria
 *   (`agent_configs.hook_params.assisted_mode.redirect_messages`).
 */
export function classifyAssistedModeOutput(
  text: string | null | undefined,
  classifier: AssistedModeClassifier | null | undefined,
  redirects: AssistedModeRedirectMessages | null | undefined,
): ClassifierResult {
  // Texto vazio: nada a classificar — passthrough.
  if (!text || typeof text !== 'string' || text.length === 0) {
    return { category: null, redirect: null };
  }

  // Config faltando: passthrough defensivo (response-guard cai no path legacy
  // do Bloco 4 — emite `assisted_mode_passthrough` com classifier_pending=true).
  if (!classifier || !redirects) {
    return { category: null, redirect: null };
  }

  const compiled = getCompiledClassifier(classifier);

  // Precedência: duplicate_handoff > monetary > booking.
  if (compiled.duplicate_handoff.some((re) => re.test(text))) {
    return { category: 'duplicate_handoff', redirect: null, silence: true };
  }

  if (compiled.monetary.some((re) => re.test(text))) {
    // Defensive: se redirect_messages.monetary não for string, cai em passthrough
    // (não bloqueia o envio quando a config está parcialmente preenchida).
    const redirect = redirects.monetary;
    if (typeof redirect === 'string' && redirect.length > 0) {
      return { category: 'monetary', redirect };
    }
    return { category: null, redirect: null };
  }

  if (compiled.booking.some((re) => re.test(text))) {
    const redirect = redirects.booking;
    if (typeof redirect === 'string' && redirect.length > 0) {
      return { category: 'booking', redirect };
    }
    return { category: null, redirect: null };
  }

  return { category: null, redirect: null };
}
