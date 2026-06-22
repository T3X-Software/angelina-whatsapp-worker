// src/llm/anthropic.ts
//
// Bloco 8 — Task 46.
//
// Cliente Claude (Anthropic SDK 0.92.0) com:
//   - Mapeamento Tool[] -> Anthropic.Tool[] via z.toJSONSchema (Zod 4 nativo).
//   - Prompt caching (cache_control: ephemeral) em system_prompt + tools[última]
//     quando o tamanho estimado supera o threshold mínimo do cache (1024 tokens).
//     Estimativa via length/4 (proxy conservador — Anthropic auto-skip se underflow).
//   - Tracing via EventBus: `llm_request_start` e `llm_request_end`.
//   - Retry: 1× backoff 500ms em 5xx/timeout/429. Outros 4xx propagam.
//   - LLMUnavailableError após retry esgotado (loop captura para fallback).
//
// IMPORTANTE: este módulo NÃO conhece o ciclo de tool dispatch. Ele recebe
// `messages + tools` e devolve UMA resposta (text + toolCalls). Quem decide
// dispatch e re-call é o `loop.ts`.

import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';

import { env } from '../env';
import { calculateCost } from './pricing';
import {
  LLMUnavailableError,
  type LLMContentBlock,
  type LLMMessage,
  type LLMResponse,
  type LLMStopReason,
  type LLMToolCall,
  type LLMToolDefinition,
  type LLMToolJSONSchema,
} from './types';
import type { AnyTool, EventBus } from '../harness/types';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton client (criado lazy — facilita o smoke 2 que troca env on the fly)
// ─────────────────────────────────────────────────────────────────────────────

let _client: Anthropic | null = null;
let _clientApiKey: string | null = null;

function getClient(): Anthropic {
  // Recria se a env mudou (smoke de fallback troca a key e re-importa).
  if (_client === null || _clientApiKey !== env.ANTHROPIC_API_KEY) {
    _client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      // SDK default já é 10min; deixamos default.
      maxRetries: 0, // fazemos nosso próprio retry para ter controle do log + LLMUnavailableError.
    });
    _clientApiKey = env.ANTHROPIC_API_KEY;
  }
  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversão Tool (harness) -> LLMToolDefinition
//
// Zod 4 expõe `z.toJSONSchema(schema, { target: 'draft-2020-12' })` nativo.
// Nossas 4 tools usam apenas object + string/number/enum/optional/record(unknown),
// que o conversor cobre 100%. Removemos o `$schema` URI (Anthropic não exige
// e enxuga payload).
// ─────────────────────────────────────────────────────────────────────────────

export function toolToLLMDefinition(tool: AnyTool): LLMToolDefinition {
  const raw = z.toJSONSchema(tool.inputSchema, {
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  // strip top-level $schema (cosmético).
  delete raw['$schema'];

  // Sanitiza `required` quando vazio (Anthropic aceita mas sem benefício).
  if (Array.isArray(raw['required']) && (raw['required'] as unknown[]).length === 0) {
    delete raw['required'];
  }

  // Garante shape esperada pelo `LLMToolJSONSchema`. z.toJSONSchema sempre
  // emite `type: 'object'` no topo para ZodObject — confirmamos.
  if (raw['type'] !== 'object') {
    throw new Error(
      `[llm/anthropic] tool '${tool.name}' must have a top-level 'object' Zod schema (got type=${String(raw['type'])})`,
    );
  }

  const schema: LLMToolJSONSchema = {
    type: 'object',
    properties: (raw['properties'] as Record<string, unknown>) ?? {},
    required: raw['required'] as string[] | undefined,
    additionalProperties:
      typeof raw['additionalProperties'] === 'boolean'
        ? (raw['additionalProperties'] as boolean)
        : undefined,
  };

  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Caching heuristic
//
// Cache breakpoints custam (cache_creation 1.25× input). Aplicamos quando o
// conteúdo supera ~1024 tokens (≈ 4096 chars na heurística length/4). Anthropic
// silently no-op se vier abaixo do mínimo, então é seguro errar para o lado
// do "marca caching".
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_MIN_CHARS = 4096; // ~1024 tokens

function shouldCache(text: string): boolean {
  return text.length >= CACHE_MIN_CHARS;
}

function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento LLMMessage -> Anthropic.MessageParam
// ─────────────────────────────────────────────────────────────────────────────

function llmContentBlockToSdk(block: LLMContentBlock): ContentBlockParam {
  if (block.type === 'text') {
    return {
      type: 'text',
      text: block.text,
      ...(block.cache_control ? { cache_control: block.cache_control } : {}),
    };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    };
  }
  // tool_result
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
    ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
  };
}

function llmMessageToSdk(msg: LLMMessage): MessageParam {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  return {
    role: msg.role,
    content: msg.content.map(llmContentBlockToSdk),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry helper
// ─────────────────────────────────────────────────────────────────────────────

interface CallAttemptResult {
  ok: true;
  response: Anthropic.Message;
}

interface CallAttemptError {
  ok: false;
  error: unknown;
  status: number | null;
  retriable: boolean;
}

function classifyError(err: unknown): { status: number | null; retriable: boolean } {
  // Anthropic SDK exporta APIError; usamos type-narrow defensivo.
  // 5xx, 408, 429, network/timeout/abort -> retriable.
  // 4xx (exceto 408/429) -> permanente.
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? null;
    if (status === null) return { status: null, retriable: true };
    if (status >= 500) return { status, retriable: true };
    if (status === 408 || status === 429) return { status, retriable: true };
    return { status, retriable: false };
  }
  // Connection errors do SDK herdam de APIConnectionError -> sem .status
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: null, retriable: true };
  }
  // Outros (TypeError, AbortError) -> retriable (defensivo).
  return { status: null, retriable: true };
}

async function singleAttempt(
  args: Anthropic.MessageCreateParamsNonStreaming,
): Promise<CallAttemptResult | CallAttemptError> {
  try {
    const response = await getClient().messages.create(args);
    return { ok: true, response };
  } catch (err) {
    const { status, retriable } = classifyError(err);
    return { ok: false, error: err, status, retriable };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// callClaude — entrada pública
// ─────────────────────────────────────────────────────────────────────────────

export interface CallClaudeArgs {
  systemPrompt: string;
  messages: LLMMessage[];
  tools: AnyTool[];
  model: string;
  temperature: number;
  maxTokens?: number;
  /** Bus per-turn — usado para emit `llm_request_start`/`llm_request_end`. */
  eventBus?: EventBus;
  /**
   * Iteração no loop de tool dispatch (0-indexada). Usado só para tracing —
   * permite correlacionar custos e tokens por iteração no painel.
   */
  iteration?: number;
  /**
   * Força (ou orienta) a escolha de tool pelo modelo. Aditivo e
   * retrocompatível: quando omitido, o SDK usa o default (`auto`) — exatamente
   * o comportamento da harness. Usado pelo agente analista para FORÇAR a tool
   * de saída estruturada (`{ type: 'tool', name: 'report_insights' }`).
   */
  toolChoice?: Anthropic.MessageCreateParams['tool_choice'];
}

export async function callClaude(
  args: CallClaudeArgs,
): Promise<LLMResponse> {
  const {
    systemPrompt,
    messages,
    tools,
    model,
    temperature,
    maxTokens = 4096,
    eventBus,
    iteration,
    toolChoice,
  } = args;

  // ── Caching: marca system_prompt + último tool quando elegíveis ─────────
  const cacheSystem = shouldCache(systemPrompt);
  const sdkTools: Anthropic.Tool[] = tools.map((t) => {
    const llmDef = toolToLLMDefinition(t);
    return {
      name: llmDef.name,
      description: llmDef.description,
      input_schema: llmDef.input_schema as Anthropic.Tool.InputSchema,
    };
  });
  // Último tool ganha cache breakpoint quando soma "razoável" (>=1024 tok ≈ 4096 chars).
  if (sdkTools.length > 0) {
    const totalToolChars = sdkTools.reduce(
      (acc, t) => acc + (t.description?.length ?? 0) + JSON.stringify(t.input_schema).length,
      0,
    );
    if (totalToolChars >= CACHE_MIN_CHARS) {
      const last = sdkTools[sdkTools.length - 1];
      last.cache_control = { type: 'ephemeral' };
    }
  }

  // System como bloco para suportar cache_control.
  const systemBlocks: Anthropic.TextBlockParam[] = cacheSystem
    ? [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ]
    : [{ type: 'text', text: systemPrompt }];

  const sdkMessages: MessageParam[] = messages.map(llmMessageToSdk);

  const createParams: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemBlocks,
    messages: sdkMessages,
    ...(sdkTools.length > 0 ? { tools: sdkTools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };

  // ── Trace start ─────────────────────────────────────────────────────────
  if (eventBus) {
    eventBus.emit(
      'llm_request_start',
      {
        model,
        n_messages: messages.length,
        n_tools: tools.length,
        cache_system: cacheSystem,
        estimated_system_tokens: estimatedTokens(systemPrompt),
        ...(iteration !== undefined ? { iteration } : {}),
      },
      'info',
    );
  }

  // ── Attempt 1 ───────────────────────────────────────────────────────────
  const t0 = performance.now();
  let result = await singleAttempt(createParams);
  let attempts = 1;

  // ── Retry once (500ms) on retriable ─────────────────────────────────────
  if (!result.ok && result.retriable) {
    await sleep(500);
    result = await singleAttempt(createParams);
    attempts = 2;
  }

  const latencyMs = Math.round(performance.now() - t0);

  if (!result.ok) {
    const errMsg =
      result.error instanceof Error
        ? result.error.message
        : String(result.error);
    if (eventBus) {
      eventBus.emit(
        'llm_request_end',
        {
          model,
          ok: false,
          attempts,
          latency_ms: latencyMs,
          status: result.status,
          retriable: result.retriable,
          error: errMsg,
          ...(iteration !== undefined ? { iteration } : {}),
        },
        'high',
      );
    }
    throw new LLMUnavailableError(
      `Anthropic call failed after ${attempts} attempt(s): ${errMsg}`,
      result.error,
      model,
    );
  }

  const resp = result.response;

  // ── Parse content blocks -> texto agregado + toolCalls ──────────────────
  let textOut = '';
  const toolCalls: LLMToolCall[] = [];
  for (const block of resp.content) {
    if (block.type === 'text') {
      textOut += (textOut ? '\n' : '') + block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    // outros (thinking, server_tool_use, etc) — não usados nesta feature.
  }

  const usage = resp.usage;
  const tokensIn = usage.input_tokens;
  const tokensOut = usage.output_tokens;
  const cacheReadIn = usage.cache_read_input_tokens ?? 0;
  const cacheCreateIn = usage.cache_creation_input_tokens ?? 0;
  const costUsd = calculateCost(model, tokensIn, tokensOut, cacheReadIn, cacheCreateIn);

  // ── Trace end ───────────────────────────────────────────────────────────
  if (eventBus) {
    eventBus.emit(
      'llm_request_end',
      {
        model,
        ok: true,
        attempts,
        latency_ms: latencyMs,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cache_read_input_tokens: cacheReadIn,
        cache_creation_input_tokens: cacheCreateIn,
        cost_usd: costUsd,
        stop_reason: resp.stop_reason,
        n_tool_calls: toolCalls.length,
        ...(iteration !== undefined ? { iteration } : {}),
      },
      'info',
    );
  }

  return {
    text: textOut,
    toolCalls,
    stopReason: (resp.stop_reason as LLMStopReason | null) ?? null,
    usage: {
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cacheReadInputTokens: cacheReadIn,
      cacheCreationInputTokens: cacheCreateIn,
    },
    model: resp.model,
  };
}
