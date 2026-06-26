// src/utils/openai-embedding.ts
//
// Bloco 2 — Tasks #9, #10, #11, #12 da feature `rag-knowledge-population`.
//
// Helper puro que envolve `client.embeddings.create` (OpenAI SDK v6) com:
//   - Lazy-singleton do client (1× por processo, recriado se a key mudar — útil
//     em smokes que sobrescrevem env on-the-fly; mesmo padrão de `llm/anthropic.ts`).
//   - Retry exponencial: 3 tentativas (200ms, 800ms, 2000ms) — APENAS em 5xx,
//     timeout ou erro de conexão. NÃO retry em 4xx (auth/quota/invalid_input
//     são fail-fast).
//   - SDK roda com `maxRetries: 0` para evitar retentar duplicado por cima do nosso.
//   - Validação de shape: vetor `Array<number>` de length=1536 sem NaN/Infinity.
//     Senão throw `EmbedShapeError`.
//   - Tracing opcional via EventBus (mesmo padrão do `callClaude`):
//       - `openai_embed_call` (info) em sucesso → { model, tokens_used, latency_ms }
//       - `openai_embed_failed` (med) em falha terminal → { error, status_code, attempt_n }
//     **Privacidade:** o texto bruto NUNCA aparece nos traces (apenas comprimento).
//
// Por que receber `eventBus` como parâmetro (e não via ctx)?
//   Esta função é util de baixo nível — chamada tanto pelo composer (que tem
//   `ctx.eventBus`) quanto por scripts/backfill (que criam stub ou não tracam).
//   Acoplá-la ao HarnessContext quebraria reuso. O caller decide tracing.
//
// Invariantes preservadas:
//   - Hooks NÃO chamam LLM (#3) — embeddings é query semântica determinística,
//     não chat completion (decisão registrada no brief: "Embed ≠ LLM chat").
//   - Tools NÃO enviam mensagem (#4) — esta função não envia nada.
//   - response-guard ainda é último step antes de send (#1) — não tocado aqui.

import OpenAI from 'openai';
import { env } from '../env';

import type { EventBus } from '../harness/types';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes / defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default model — bate com o sub-objeto `agent_configs.hook_params.rag.model`
 * da migration 20260510120000_rag_pipeline. Caller pode injetar via `opts.model`
 * (composer lê de `ctx.config.hookParams.rag.model`).
 */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Default timeout — agressivo o suficiente para falhar rápido e retentar (3
 * tentativas com backoff somando ~3s no pior caso ainda cabem em < 35s no
 * orçamento total de turno).
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Dimensão do output esperado para `text-embedding-3-small`. Se o caller passar
 * outro model com dim diferente, esta validação falhará — neste MVP, isso é
 * **desejado** (toda a coluna `knowledge_articles.embedding` é `vector(1536)`,
 * mismatch deve ser detectado antes do INSERT).
 */
export const EXPECTED_DIM = 1536;

/**
 * Backoff exponencial em ms — 3 attempts (200, 800, 2000). Total no pior
 * caso (3 falhas + 2 sleeps): ~3s + tempo das chamadas. Cabe no orçamento.
 */
const BACKOFF_MS = [200, 800, 2000] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Erros
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lançado quando o vetor retornado pela OpenAI tem shape inesperado:
 *   - não é Array
 *   - length !== EXPECTED_DIM (1536)
 *   - contém NaN ou não-finito
 *
 * Caller (composer) deve tratar como falha terminal e fazer fail-open
 * (skip RAG + emit `rag_embed_failed`, turno segue).
 */
export class EmbedShapeError extends Error {
  public readonly receivedLength: number | null;
  public readonly hasNaN: boolean;

  constructor(message: string, receivedLength: number | null, hasNaN: boolean) {
    super(message);
    this.name = 'EmbedShapeError';
    this.receivedLength = receivedLength;
    this.hasNaN = hasNaN;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client (lazy singleton)
// ─────────────────────────────────────────────────────────────────────────────

let _client: OpenAI | null = null;
let _clientApiKey: string | null = null;
let _clientTimeoutMs: number | null = null;

/**
 * Constrói/recicla o client. Recria quando a key OU o timeout efetivo mudou
 * — necessário para smokes que sobrescrevem env on-the-fly (mesmo trick do
 * `llm/anthropic.ts`).
 *
 * Lê `env.OPENAI_API_KEY` (validado no `env.ts` como OPCIONAL — a ausência NÃO
 * derruba o boot, só emite warning; RAG é feature-flagged via
 * `agent_configs.hook_params.rag`). Mantemos o guard de ausência DENTRO do
 * helper (throw) para o caso de a feature ser usada sem a key configurada.
 */
function getClient(timeoutMs: number): OpenAI {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      '[openai-embedding] OPENAI_API_KEY ausente do ambiente. ' +
        'Configure em `whatsapp-worker/.env` (dev) ou `.env.production` (VPS).',
    );
  }

  if (
    _client === null ||
    _clientApiKey !== apiKey ||
    _clientTimeoutMs !== timeoutMs
  ) {
    _client = new OpenAI({
      apiKey,
      timeout: timeoutMs,
      maxRetries: 0, // Nosso próprio retry — evita duplicação.
    });
    _clientApiKey = apiKey;
    _clientTimeoutMs = timeoutMs;
  }
  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classificação de erro (retriável vs terminal)
// ─────────────────────────────────────────────────────────────────────────────

interface ErrorClassification {
  status: number | null;
  retriable: boolean;
}

/**
 * 5xx, timeout, network → retriable.
 * 4xx (auth/quota/invalid_input) → terminal (fail fast).
 * Outros (TypeError, AbortError externo) → retriable (defensivo).
 */
function classifyError(err: unknown): ErrorClassification {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? null;
    if (status === null) return { status: null, retriable: true };
    if (status >= 500) return { status, retriable: true };
    // 408 timeout, 429 rate-limit (quota) — quota costuma ser permanente,
    // mas backoff curto ajuda em rate-limit transitório (TPM bursty).
    // Mantemos 429 retriable (mesmo padrão do anthropic.ts), 408 idem.
    if (status === 408 || status === 429) return { status, retriable: true };
    // 400/401/403/404/422 — terminal.
    return { status, retriable: false };
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return { status: null, retriable: true };
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return { status: null, retriable: true };
  }
  // Genéricos — defensivo.
  return { status: null, retriable: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação de shape
// ─────────────────────────────────────────────────────────────────────────────

function validateEmbedding(vec: unknown): number[] {
  if (!Array.isArray(vec)) {
    throw new EmbedShapeError(
      `[openai-embedding] embedding não é Array (got ${typeof vec})`,
      null,
      false,
    );
  }
  if (vec.length !== EXPECTED_DIM) {
    throw new EmbedShapeError(
      `[openai-embedding] embedding length=${vec.length} mas esperado=${EXPECTED_DIM}`,
      vec.length,
      false,
    );
  }
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new EmbedShapeError(
        `[openai-embedding] embedding[${i}]=${String(x)} (NaN/Infinity/não-numérico)`,
        vec.length,
        true,
      );
    }
  }
  return vec as number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedOptions {
  /** Override do model. Default: `DEFAULT_EMBEDDING_MODEL`. */
  model?: string;
  /** Timeout por tentativa (não total). Default: `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** EventBus per-turn — se omitido, não emite traces. */
  eventBus?: EventBus;
}

/**
 * Embed de texto único → vetor 1536-d.
 *
 * Comportamento:
 *   - Sucesso: retorna `number[]` validado, emit `openai_embed_call` se eventBus.
 *   - Falha terminal (4xx ou após 3 tentativas em 5xx/timeout): emit
 *     `openai_embed_failed` se eventBus, e re-throw o erro original.
 *   - Shape inválido após sucesso da API: throw `EmbedShapeError` (sem retry —
 *     bug do servidor, não vai mudar).
 *
 * O texto bruto NÃO é incluído no payload dos traces — apenas seu comprimento.
 */
export async function embedText(
  text: string,
  opts: EmbedOptions = {},
): Promise<number[]> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const eventBus = opts.eventBus;

  const t0 = performance.now();
  let lastError: unknown = null;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const client = getClient(timeoutMs);
      const res = await client.embeddings.create({
        model,
        input: text,
      });

      const rawVec = res.data?.[0]?.embedding;
      const vec = validateEmbedding(rawVec);
      const tokensUsed = res.usage?.total_tokens ?? null;

      if (eventBus) {
        eventBus.emit(
          'openai_embed_call',
          {
            model,
            tokens_used: tokensUsed,
            latency_ms: Math.round(performance.now() - t0),
            input_chars: text.length,
            attempt_n: attempt,
          },
          'info',
        );
      }
      return vec;
    } catch (err) {
      lastError = err;

      // Shape inválido — não retentar (bug do servidor, sem ganho em retry).
      if (err instanceof EmbedShapeError) {
        if (eventBus) {
          eventBus.emit(
            'openai_embed_failed',
            {
              model,
              error: err.message,
              error_kind: 'shape',
              received_length: err.receivedLength,
              has_nan: err.hasNaN,
              attempt_n: attempt,
              latency_ms: Math.round(performance.now() - t0),
            },
            'med',
          );
        }
        throw err;
      }

      const cls = classifyError(err);
      lastStatus = cls.status;

      // 4xx terminal — fail-fast.
      if (!cls.retriable) {
        const msg = err instanceof Error ? err.message : String(err);
        if (eventBus) {
          eventBus.emit(
            'openai_embed_failed',
            {
              model,
              error: msg,
              error_kind: 'terminal',
              status_code: cls.status,
              attempt_n: attempt,
              latency_ms: Math.round(performance.now() - t0),
            },
            'med',
          );
        }
        throw err;
      }

      // Retriable — sleep e tenta de novo (se sobrar tentativa).
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt - 1]!);
        continue;
      }
      // Esgotou — cai pro emit final fora do loop.
    }
  }

  // Esgotamos as 3 tentativas em erros retriáveis.
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  if (eventBus) {
    eventBus.emit(
      'openai_embed_failed',
      {
        model,
        error: msg,
        error_kind: 'retries_exhausted',
        status_code: lastStatus,
        attempt_n: BACKOFF_MS.length,
        latency_ms: Math.round(performance.now() - t0),
      },
      'med',
    );
  }
  throw lastError;
}
