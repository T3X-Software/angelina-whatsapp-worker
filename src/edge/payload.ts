// src/edge/payload.ts
//
// Schemas Zod do payload Zapster e função de parse usada pelo preHandler de
// auth (Bloco 2 #11) e pelo handler do webhook (Bloco 2 #13).
//
// Observação importante (registrada no implementation-log em 2026-05-02 16:08):
// Há divergência entre o brief/tasks.md (que fala em `data.message.{id, type,
// text, media}`) e o payload REAL capturado dos workflows n8n legacy do Sergio
// (`workflow-atendimento/workflow.json` linhas 1010-1037), que usa formato
// "achatado": `body.data.{id, type, content.text, sender, recipient, sent_at}`.
//
// Aceitamos AMBOS os formatos via união discriminada (preferred = aninhado);
// a função `parseWebhookPayload` retorna sempre a forma normalizada do brief
// (`data.message.{id, type, text, media}`) para o resto do código consumir
// um shape único.
//
// Em todos os níveis usamos `passthrough()` — Zapster pode adicionar campos
// novos sem quebrar nada (defensive programming).

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Componentes compartilhados
// ─────────────────────────────────────────────────────────────────────────────

const SenderSchema = z
  .object({
    // E.164 do remetente (sem o `+`, conforme o payload real do Zapster).
    id: z.string().min(1),
  })
  .passthrough();

const RecipientSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['chat', 'group']),
  })
  .passthrough();

// `media` é um objeto livre — pode vir vazio, parcial ou completo.
// Em Zod 4 não existe `partial()` em `z.object().optional()` no padrão antigo;
// usamos `.optional()` em todos os campos manualmente.
const MediaSchema = z
  .object({
    url: z.string().optional(),
    mime_type: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough()
  .optional();

const KnownMessageType = z.enum([
  'text',
  'audio',
  'image',
  'video',
  'document',
  'sticker',
  'location',
  'contact',
]);

// Aceita os tipos conhecidos OU qualquer string (Zapster pode introduzir tipos
// novos no futuro — preferimos aceitar e logar a downstream do que rejeitar
// no edge).
const MessageTypeSchema = z.union([KnownMessageType, z.string().min(1)]);

// ─────────────────────────────────────────────────────────────────────────────
// Forma A — payload "aninhado" (descrito no brief / tasks #12)
// ─────────────────────────────────────────────────────────────────────────────

const NestedMessageSchema = z
  .object({
    id: z.string().min(1),
    type: MessageTypeSchema,
    text: z.string().optional(),
    media: MediaSchema,
  })
  .passthrough();

const NestedDataSchema = z
  .object({
    sender: SenderSchema,
    recipient: RecipientSchema,
    message: NestedMessageSchema,
  })
  .passthrough();

const NestedPayloadSchema = z
  .object({
    data: NestedDataSchema,
  })
  .passthrough();

// ─────────────────────────────────────────────────────────────────────────────
// Forma B — payload "achatado" (formato REAL observado nos workflows n8n legacy)
// `body.data.{id, type, content.text, sender, recipient, sent_at}`
// ─────────────────────────────────────────────────────────────────────────────

const FlatContentSchema = z
  .object({
    text: z.string().optional(),
    url: z.string().optional(),
    mime_type: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough()
  .optional();

const FlatDataSchema = z
  .object({
    id: z.string().min(1),
    type: MessageTypeSchema,
    sender: SenderSchema,
    recipient: RecipientSchema,
    content: FlatContentSchema,
  })
  .passthrough();

const FlatPayloadSchema = z
  .object({
    data: FlatDataSchema,
  })
  .passthrough();

// ─────────────────────────────────────────────────────────────────────────────
// Tipo público — a forma normalizada que o resto do código vai consumir.
// ─────────────────────────────────────────────────────────────────────────────

export type WebhookMessageMedia = {
  url?: string;
  mime_type?: string;
  filename?: string;
};

export type WebhookMessage = {
  id: string;
  type: string; // string aberta para permitir tipos novos do Zapster
  text?: string;
  media?: WebhookMessageMedia;
};

export type WebhookSender = { id: string };
export type WebhookRecipient = { id: string; type: 'chat' | 'group' };

export type WebhookPayload = {
  data: {
    sender: WebhookSender;
    recipient: WebhookRecipient;
    message: WebhookMessage;
  };
  // Campos extras do payload bruto preservados — útil para debug/tracing.
  raw?: unknown;
};

// ─────────────────────────────────────────────────────────────────────────────
// Função pública — `parseWebhookPayload(body)` retorna result normalizado
// ─────────────────────────────────────────────────────────────────────────────

export type ParseResult =
  | { success: true; data: WebhookPayload }
  | { success: false; error: z.ZodError };

/**
 * Tenta parsear o body como payload Zapster. Aceita as duas formas conhecidas
 * (aninhada e achatada) e retorna sempre a forma NORMALIZADA (aninhada). Em
 * caso de falha, retorna o erro Zod do schema mais específico (aninhado).
 */
export function parseWebhookPayload(body: unknown): ParseResult {
  // Tenta aninhada primeiro — é o formato preferido do brief/tasks.md.
  const nested = NestedPayloadSchema.safeParse(body);
  if (nested.success) {
    const d = nested.data.data;
    return {
      success: true,
      data: {
        data: {
          sender: { id: d.sender.id },
          recipient: { id: d.recipient.id, type: d.recipient.type },
          message: {
            id: d.message.id,
            type: d.message.type,
            text: d.message.text,
            media: d.message.media
              ? {
                  url: d.message.media.url,
                  mime_type: d.message.media.mime_type,
                  filename: d.message.media.filename,
                }
              : undefined,
          },
        },
        raw: body,
      },
    };
  }

  // Fallback: tenta a forma achatada (payload real observado).
  const flat = FlatPayloadSchema.safeParse(body);
  if (flat.success) {
    const d = flat.data.data;
    return {
      success: true,
      data: {
        data: {
          sender: { id: d.sender.id },
          recipient: { id: d.recipient.id, type: d.recipient.type },
          message: {
            id: d.id,
            type: d.type,
            text: d.content?.text,
            media:
              d.content && (d.content.url || d.content.mime_type || d.content.filename)
                ? {
                    url: d.content.url,
                    mime_type: d.content.mime_type,
                    filename: d.content.filename,
                  }
                : undefined,
          },
        },
        raw: body,
      },
    };
  }

  // Nenhuma das duas formas casou — retorna o erro do schema aninhado
  // (mais informativo, é o formato canônico do brief).
  return { success: false, error: nested.error };
}
