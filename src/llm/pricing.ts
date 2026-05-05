// src/llm/pricing.ts
//
// Bloco 8 — Task 45.
//
// Tabela fixa de preços por modelo Anthropic (em USD por milhão de tokens).
// Fontes:
//   - https://www.anthropic.com/pricing#api (snapshot em 2026-05-03)
//   - claude-sonnet-4-6 (=== claude-sonnet-4-5 alias 4.6) usa tier Sonnet 4 series.
//
// Decisão (Bloco 8): tabela hard-coded aqui. Se o pricing mudar, atualizamos
// no PR — não vai para `agent_configs` porque é metadata global do provider,
// não específico do agent. Modelos desconhecidos default para tier Sonnet
// (mais conservador — superestima custo, evita underestimar).
//
// `calculateCost` retorna USD com precisão ~6 casas decimais (suficiente
// para guardar em `messages.cost_usd numeric(10,6)`).

export interface ModelPricing {
  /** USD por 1M tokens de input "fresco" (sem cache). */
  inputPerMTok: number;
  /** USD por 1M tokens de output. */
  outputPerMTok: number;
  /** USD por 1M tokens de cache write (cache_creation_input_tokens). */
  cacheWritePerMTok: number;
  /** USD por 1M tokens de cache read (cache_read_input_tokens). */
  cacheReadPerMTok: number;
}

/**
 * Tabela de preços. Chaves devem casar com `agent_configs.model` exato.
 *
 * `claude-sonnet-4-6` é o modelo principal da Angelina (CLAUDE.md raiz).
 * Aliases populares incluídos (claude-sonnet-4-5 — tier idêntico).
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Sonnet 4.x (tier $3 / $15 — referência do Sonnet 3.5/3.7/4.x).
  'claude-sonnet-4-6': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  'claude-sonnet-4-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  'claude-3-5-sonnet-latest': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  'claude-3-5-sonnet-20241022': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  // Haiku (tier mais barato — ainda não usado, deixado como referência).
  'claude-3-5-haiku-latest': {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheWritePerMTok: 1,
    cacheReadPerMTok: 0.08,
  },
  // Opus (tier mais caro — ainda não usado).
  'claude-opus-4-1': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheWritePerMTok: 18.75,
    cacheReadPerMTok: 1.5,
  },
};

/**
 * Default conservador para modelos não-mapeados — usa o tier Sonnet
 * (3/15/3.75/0.3). Evita underestimar custo silenciosamente.
 */
const DEFAULT_PRICING: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
};

/**
 * Calcula custo total em USD.
 *
 * Notação Anthropic Usage:
 *   - `input_tokens`               — tokens de input "novos" (sem cache).
 *   - `cache_creation_input_tokens` — tokens NOVOS escritos no cache (1.25× input).
 *   - `cache_read_input_tokens`    — tokens lidos do cache (0.10× input).
 *   - `output_tokens`              — tokens gerados pelo modelo.
 *
 * Total = input*price + output*price + cacheWrite*priceWrite + cacheRead*priceRead.
 *
 * @returns USD com 6 casas decimais (compatível com `numeric(10,6)`).
 */
export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheReadIn = 0,
  cacheCreateIn = 0,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const M = 1_000_000;
  const cost =
    (tokensIn * pricing.inputPerMTok) / M +
    (tokensOut * pricing.outputPerMTok) / M +
    (cacheCreateIn * pricing.cacheWritePerMTok) / M +
    (cacheReadIn * pricing.cacheReadPerMTok) / M;
  // Round to 6 decimals; banker's rounding fica para o Postgres.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
