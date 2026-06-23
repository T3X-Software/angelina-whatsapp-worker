// src/zapster/types.ts
//
// Bloco 9 — REAL. Tipos compartilhados do client Zapster.
//
// Substitui o stub do Bloco 6 com Zod schemas para `SendRequest`/`SendResponse`,
// classe `ZapsterError` para retry policy diferenciada (transient vs permanent),
// e mantém compat com `ZapsterSendInput`/`ZapsterSendResult` consumidos por
// `transfer-trigger` (invariante 5 — bypass response-guard) e `human-delay`
// (typing indicator best-effort).
//
// `WebhookPayload` permanece re-exportado de `src/edge/payload.ts` (Bloco 2).

import { z } from 'zod';

export type { WebhookPayload } from '../edge/payload';

/**
 * Input mínimo para `ZapsterClient.send()`. Mantido idêntico ao stub do
 * Bloco 6 para não quebrar callers (`transfer-trigger`, `human-delay`,
 * `sender.ts`).
 *
 *   - `recipientId`: E.164 SEM `+` para chat 1:1 (ex: `5519997124472`),
 *     ou ID do grupo SEM o prefixo `group:` (o client adiciona ao montar
 *     o body). Convenção do projeto consolidada no Bloco 4 (E.164 sem `+`).
 *   - `recipientType`: define a forma final do `recipient` enviado à Zapster.
 *   - `text`: vai para `text` no body. Opcional quando `media` está presente.
 *   - `media`: mídia a enviar (Feature 1.9 — ADR 0003).
 */
export interface MediaPayload {
  /** URL pública da mídia (XOR com `base64`). */
  url?: string;
  /** Mídia em base64 (XOR com `url`). */
  base64?: string;
  /** Legenda (image/video/document). */
  caption?: string;
  /** Nome do arquivo (ex: PDF). */
  fileName?: string;
  /** Áudio como push-to-talk (default true na Zapster). */
  ptt?: boolean;
  /** Vídeo como video note. */
  ptv?: boolean;
  /** Vídeo em loop. */
  playback?: boolean;
  /** Imagem como sticker. */
  sticker?: boolean;
}

export interface ZapsterSendInput {
  recipientId: string;
  recipientType: 'chat' | 'group';
  /** Texto da mensagem. Opcional quando `media` está presente (Feature 1.9). */
  text?: string;
  /** Mídia a enviar (Feature 1.9). Legenda via `media.caption`. */
  media?: MediaPayload;
}

/**
 * Resultado do send. `zapsterMessageId` é o id devolvido pela Zapster,
 * gravado em `messages.zapster_message_id` (CHECK_3 exige NOT NULL para
 * `send_status='sent'`).
 */
export interface ZapsterSendResult {
  zapsterMessageId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire format (Zapster API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body enviado para `POST /wa/messages`.
 *
 *   - `instance_id`: vem de `env.ZAPSTER_INSTANCE_ID`.
 *   - `recipient`: E.164 sem `+` para chat OU `group:{id}` para group
 *     (montagem responsabilidade do client; aqui só validamos a string final).
 *   - `text`: conteúdo da mensagem.
 */
/**
 * Objeto `media` do body (Feature 1.9 — ADR 0003). Exatamente UM de `url`/`base64`.
 */
export const MediaPayloadSchema = z
  .object({
    url: z.string().url().optional(),
    base64: z.string().min(1).optional(),
    caption: z.string().optional(),
    fileName: z.string().optional(),
    ptt: z.boolean().optional(),
    ptv: z.boolean().optional(),
    playback: z.boolean().optional(),
    sticker: z.boolean().optional(),
  })
  .refine((m) => (m.url !== undefined) !== (m.base64 !== undefined), {
    message: 'media requer exatamente um de `url` ou `base64`',
  });
export type MediaPayloadWire = z.infer<typeof MediaPayloadSchema>;

export const SendRequestSchema = z
  .object({
    instance_id: z.string().min(1),
    recipient: z.string().min(1),
    text: z.string().min(1).optional(),
    media: MediaPayloadSchema.optional(),
  })
  .refine(
    (b) => (b.text !== undefined && b.text.length > 0) || b.media !== undefined,
    { message: 'send requer `text` ou `media`' },
  );
export type SendRequest = z.infer<typeof SendRequestSchema>;

/**
 * Response esperada da Zapster. Usamos `passthrough` para tolerância a
 * campos extras que o gateway possa adicionar (e não quebrar nosso parser).
 *
 * Shape real capturado em 2026-05-03 via curl manual:
 *   { "message_id": "3EB08A5992CFCF3202B945", "message_trace_id": "ktebVnuw2OLs6tg5iufFM2XtfYe2TXSj" }
 *
 * NÃO existe campo `status` na resposta de sucesso — o status é o HTTP 200.
 * O assumption original (`status: z.string()`) quebrava todo send: 200 OK +
 * shape inválido → ZapsterError(isTransient=true) → 3 retries → 3 entregas
 * duplicadas no WhatsApp do destinatário. Bug capturado em smoke local
 * (`5519997124472`, 2026-05-03 19:52–19:58, 5 turnos × 3 retries cada).
 */
export const SendResponseSchema = z
  .object({
    message_id: z.string().min(1),
    message_trace_id: z.string().optional(),
  })
  .passthrough();
export type SendResponse = z.infer<typeof SendResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Error class — diferencia retry policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erro lançado pelo `ZapsterClient`. `isTransient=true` indica que a falha
 * é transitória (5xx, timeout, network, 429) e elegível para retry com
 * backoff exponencial. `isTransient=false` indica falha permanente
 * (4xx exceto 429) e o client throwa imediatamente sem retry.
 *
 * `response` traz o body bruto da Zapster (quando disponível) para
 * facilitar debug em logs/traces.
 */
export class ZapsterError extends Error {
  readonly statusCode: number;
  readonly response?: unknown;
  readonly isTransient: boolean;

  constructor(
    message: string,
    opts: { statusCode: number; response?: unknown; isTransient: boolean },
  ) {
    super(message);
    this.name = 'ZapsterError';
    this.statusCode = opts.statusCode;
    this.response = opts.response;
    this.isTransient = opts.isTransient;
  }
}
