// src/zapster/client.ts
//
// Bloco 9 — REAL Zapster client. Substitui STUB do Bloco 6.
//
// Responsabilidades:
//   - POST `${ZAPSTER_API_URL}/wa/messages` com `Authorization: Bearer ${API_KEY}`.
//   - Body `{instance_id, recipient, text}` validado com Zod.
//   - Retry 3 attempts em erros TRANSIENT (5xx, network/timeout, 429) com
//     backoff exponencial 500ms → 2s → 8s. PERMANENT (4xx exceto 429) throwa
//     imediatamente sem retry.
//   - Tracing opcional via `eventBus`: `zapster_send_start` e `zapster_send_end`
//     com `latency_ms`, `ok`, `statusCode`, `attempts`. `recipientId` redacted.
//   - `typingIndicator(recipientId)` best-effort — nunca throwa (compat com
//     `human-delay` que o chama dentro de try/catch silencioso).
//
// ⚠️ Invariantes preservados:
//   - INVARIANTE 4: client NÃO chama LLM (apenas HTTP).
//   - INVARIANTE 5: `transfer-trigger` continua chamando `client.send()` direto
//     (bypass response-guard). Esta classe NÃO conhece a state machine —
//     quem orquestra o `pending → sending → sent` é `src/zapster/sender.ts`.
//
// Padrão `recipient`:
//   - chat: E.164 sem `+` (já vem assim do `ctx.contact.phone` / `payload.data.sender.id`).
//   - group: prefixar `group:` ao `recipientId`.

import type { Logger } from 'pino';

import { env } from '../env';
import type { EventBus } from '../harness/types';
import {
  SendRequestSchema,
  SendResponseSchema,
  ZapsterError,
  type SendRequest,
  type SendResponse,
  type ZapsterSendInput,
  type ZapsterSendResult,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Backoff em ms para os retries de erro transient. Ordem 1ª → 2ª → 3ª attempt. */
const RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 2000, 8000];
/** Total attempts = retries + 1 (a 1ª chamada). */
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/** Timeout por requisição. Conservador: Zapster costuma responder <2s. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Path do envio. Junta com `env.ZAPSTER_API_URL` (sem trailing slash). */
const SEND_PATH = '/wa/messages';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Redact final-12-digits → keep first 4 + `***`. Para tracing. */
function redactRecipient(id: string): string {
  if (id.length <= 6) return '***';
  return `${id.slice(0, 4)}***${id.slice(-2)}`;
}

/**
 * Formata `recipient` para o body da Zapster:
 *   - chat: E.164 sem `+` (já é).
 *   - group: prefixar `group:`.
 */
function formatRecipient(input: ZapsterSendInput): string {
  return input.recipientType === 'group'
    ? `group:${input.recipientId}`
    : input.recipientId;
}

/** URL final do POST. Tolerante a trailing slash em `ZAPSTER_API_URL`. */
function buildSendUrl(): string {
  const base = env.ZAPSTER_API_URL.replace(/\/+$/, '');
  return `${base}${SEND_PATH}`;
}

/**
 * Classifica status HTTP em transient vs permanent.
 *
 *   - 5xx: transient (servidor da Zapster com problema).
 *   - 429: transient (rate limit — retry com backoff).
 *   - 4xx (exceto 429): permanent (auth, payload inválido — retry inútil).
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZapsterClient
// ─────────────────────────────────────────────────────────────────────────────

export class ZapsterClient {
  constructor(
    private readonly logger: Logger,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Envia uma mensagem via Zapster.
   *
   * Loop de retry:
   *   - attempt=1: backoff 500ms se falhar transient.
   *   - attempt=2: backoff 2000ms.
   *   - attempt=3: backoff 8000ms.
   *   - Após 3 tentativas falhas → throw `ZapsterError` (última do loop).
   *
   * Erros PERMANENT (4xx exceto 429) cortam o loop e throwam imediatamente
   * (sem esperar o backoff — não adianta retentar).
   */
  async send(input: ZapsterSendInput): Promise<ZapsterSendResult> {
    const url = buildSendUrl();
    const body: SendRequest = SendRequestSchema.parse({
      instance_id: env.ZAPSTER_INSTANCE_ID,
      recipient: formatRecipient(input),
      text: input.text,
    });

    const t0 = performance.now();
    this.eventBus?.emit(
      'zapster_send_start',
      {
        recipient_redacted: redactRecipient(input.recipientId),
        recipient_type: input.recipientType,
        text_len: input.text.length,
      },
      'info',
    );

    let lastErr: Error | null = null;
    let attempts = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts = i + 1;
      try {
        const result = await this.singleAttempt(url, body);
        const latencyMs = Math.round(performance.now() - t0);
        this.eventBus?.emit(
          'zapster_send_end',
          {
            ok: true,
            attempts,
            latency_ms: latencyMs,
            zapster_message_id: result.zapsterMessageId,
          },
          'info',
        );
        return result;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const isZap = err instanceof ZapsterError;
        const transient = isZap ? (err as ZapsterError).isTransient : true;
        const statusCode = isZap ? (err as ZapsterError).statusCode : 0;

        // Permanent → não retenta. Sai do loop com o último erro.
        if (!transient) {
          break;
        }

        // Última tentativa? não dorme — sai do loop e throwa.
        if (i === MAX_ATTEMPTS - 1) {
          break;
        }

        // Transient + ainda há retentativa: dorme e tenta de novo.
        const delay = RETRY_DELAYS_MS[i];
        this.logger.warn(
          {
            event: 'zapster_send_retry',
            attempt: attempts,
            next_delay_ms: delay,
            status_code: statusCode,
            err_message: lastErr.message,
          },
          'Zapster send transient error — retrying',
        );
        await sleep(delay);
      }
    }

    // Falha total — emit + throw.
    const latencyMs = Math.round(performance.now() - t0);
    const isZap = lastErr instanceof ZapsterError;
    this.eventBus?.emit(
      'zapster_send_end',
      {
        ok: false,
        attempts,
        latency_ms: latencyMs,
        status_code: isZap ? (lastErr as ZapsterError).statusCode : 0,
        error: lastErr?.message ?? 'unknown',
      },
      'high',
    );

    if (lastErr) throw lastErr;
    throw new ZapsterError('Zapster send failed without specific error', {
      statusCode: 0,
      isTransient: true,
    });
  }

  /**
   * Typing indicator best-effort. NUNCA throwa — `human-delay` envolve em
   * try/catch silencioso, mas blindamos aqui também para garantir.
   *
   * ⚠️ Zapster não expõe endpoint público de typing indicator (por enquanto).
   * Mantemos a interface idêntica ao stub e emitimos debug log; quando o
   * gateway expor o endpoint, basta substituir o miolo desta função.
   */
  async typingIndicator(recipientId: string): Promise<void> {
    this.logger.debug(
      {
        event: 'zapster_typing_noop',
        recipient_redacted: redactRecipient(recipientId),
      },
      'Zapster typing indicator (no-op — endpoint indisponível)',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Uma única tentativa de POST. Mapeia network errors / timeout para
   * `ZapsterError(isTransient=true)`. Resposta HTTP é classificada via
   * `isTransientStatus`.
   *
   * Sucesso: parsea JSON contra `SendResponseSchema` e retorna
   * `{zapsterMessageId}`.
   */
  private async singleAttempt(
    url: string,
    body: SendRequest,
  ): Promise<ZapsterSendResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.ZAPSTER_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Network / abort / timeout — tudo transient.
      const message = err instanceof Error ? err.message : String(err);
      throw new ZapsterError(`Network error: ${message}`, {
        statusCode: 0,
        isTransient: true,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Lê o body uma vez. Tenta JSON; se não for JSON, vira string para diagnóstico.
    const rawText = await resp.text().catch(() => '');
    let parsedJson: unknown = null;
    if (rawText.length > 0) {
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        parsedJson = rawText;
      }
    }

    if (!resp.ok) {
      throw new ZapsterError(
        `Zapster returned HTTP ${resp.status}`,
        {
          statusCode: resp.status,
          response: parsedJson,
          isTransient: isTransientStatus(resp.status),
        },
      );
    }

    // Sucesso — valida shape com Zod.
    const safe = SendResponseSchema.safeParse(parsedJson);
    if (!safe.success) {
      // Resposta 2xx mas formato inesperado — tratamos como transient para
      // permitir 1 retentativa caso seja flake da Zapster (raro).
      throw new ZapsterError(
        `Zapster response shape invalid: ${safe.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        {
          statusCode: resp.status,
          response: parsedJson,
          isTransient: true,
        },
      );
    }

    const sendResp: SendResponse = safe.data;
    return { zapsterMessageId: sendResp.message_id };
  }
}
