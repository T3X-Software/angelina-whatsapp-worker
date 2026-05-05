// src/llm/types.ts
//
// Bloco 8 — Task 44.
//
// Tipos compartilhados do cliente LLM. Compatíveis com `@anthropic-ai/sdk`
// (`MessageParam`, `Tool`, `ContentBlockParam`, `Usage`), mas mantidos como
// uma camada de abstração própria para que:
//   - O loop não dependa diretamente do SDK em todas as bordas.
//   - O fallback (Bloco 8 — task 47) e futuros routers (OpenAI, etc — fora
//     desta feature) possam compartilhar a mesma forma.
//
// Estes tipos refletem APENAS o subset que a harness usa hoje:
//   - text + tool_use no output do modelo
//   - text + tool_result no input (memory L1 do Bloco 10)
//   - usage com cache_*
// Tipos não usados (image, document, thinking, server tools) ficam fora.

// ─────────────────────────────────────────────────────────────────────────────
// Content blocks (matching MessageParam.content)
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMTextBlock {
  type: 'text';
  text: string;
  /** Cache breakpoint (Anthropic prompt caching). */
  cache_control?: { type: 'ephemeral' };
}

export interface LLMToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface LLMToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /**
   * Aceitamos string serializada (mais simples para tool_result da harness).
   * Se precisar de blocks mistos no futuro, estender aqui.
   */
  content: string;
  is_error?: boolean;
}

export type LLMContentBlock =
  | LLMTextBlock
  | LLMToolUseBlock
  | LLMToolResultBlock;

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'user' | 'assistant';
  /**
   * Anthropic aceita string OU array de content blocks. Para simplicidade
   * usamos sempre array do nosso lado — o cliente serializa.
   */
  content: string | LLMContentBlock[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools (matching Anthropic SDK `Tool` interface)
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMToolJSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 2020-12 — Anthropic exige `type: 'object'` na raiz. */
  input_schema: LLMToolJSONSchema;
  /** Cache breakpoint (set no último tool da lista quando tools são "grandes"). */
  cache_control?: { type: 'ephemeral' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response
// ─────────────────────────────────────────────────────────────────────────────

export type LLMStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LLMResponse {
  /** Texto agregado de TODOS os text blocks (vazio quando o modelo só chamou tools). */
  text: string;
  /** Tool calls extraídas do response (zero ou mais). */
  toolCalls: LLMToolCall[];
  /** Stop reason crua do modelo — útil para tracing/diagnostics. */
  stopReason: LLMStopReason | null;
  usage: LLMUsage;
  /**
   * Modelo que respondeu — eco do input. Útil para pricing.calculateCost.
   */
  model: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Erros tipados
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lançado pelo `callClaude` quando o LLM principal falha de forma irrecuperável
 * (após o retry interno). O HarnessLoop captura isso e dispara o caminho de
 * fallback (`agent_configs.fallback_message`).
 *
 * NÃO inclui erros de validação (Zod do tool input) — esses são tratados
 * dentro do dispatcher do loop.
 */
export class LLMUnavailableError extends Error {
  override readonly name = 'LLMUnavailableError';

  constructor(
    message: string,
    public readonly cause: unknown,
    public readonly model: string,
  ) {
    super(message);
  }
}
