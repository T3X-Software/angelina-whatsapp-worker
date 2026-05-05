// src/harness/idempotency.ts
//
// Bloco 5 — Task 28.
//
// `claimMessage` — implementa o padrão de idempotência via UNIQUE PARCIAL +
// `ON CONFLICT (col) WHERE predicate DO NOTHING RETURNING id`.
//
// CRÍTICO (concept `idempotencia-zapster`, learn `on-conflict-em-indice-parcial`):
//   O `WHERE zapster_message_id IS NOT NULL` no `ON CONFLICT` precisa REPETIR
//   o predicado do índice parcial. Sem isso, Postgres retorna `42P10:
//   there is no unique or exclusion constraint matching the ON CONFLICT
//   specification` na primeira tentativa de duplicação.
//
// Schema-level (validado via SQL ao vivo em 2026-05-02):
//   CREATE UNIQUE INDEX messages_zapster_message_id_uidx
//     ON messages (zapster_message_id)
//     WHERE (zapster_message_id IS NOT NULL);
//
// CHECK constraints relevantes:
//   - direction='INBOUND' → send_status IS NULL E send_attempts=0 E
//     send_attempted_at IS NULL.
//   - recipient_type IN ('chat','group') OR NULL.
//
// Comportamento:
//   1. INSERT (... ON CONFLICT ... DO NOTHING RETURNING id).
//   2. Se RETURNING tem 1 linha → primeira vez → `{messageId, isDuplicate:false}`.
//   3. Se RETURNING vazio (rowCount=0) → duplicada → SELECT id da existente.
//      → `{messageId: existente, isDuplicate:true}`.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { WebhookPayload } from '../edge/payload';

export interface ClaimMessageResult {
  messageId: string;
  isDuplicate: boolean;
}

/**
 * Reivindica (insere ou identifica como duplicada) a mensagem inbound em
 * `messages`. Atomicidade garantida pelo Postgres via UNIQUE PARCIAL.
 *
 * Não escreve send_status (CHECK exige NULL para INBOUND).
 * Role é sempre `'user'` para inbound.
 *
 * @returns `{messageId, isDuplicate}` — messageId é sempre o uuid existente
 *          em `messages.id` (novo ou re-encontrado).
 */
export async function claimMessage(
  payload: WebhookPayload,
  contactId: string,
  leadId: string | null,
): Promise<ClaimMessageResult> {
  const m = payload.data.message;
  const r = payload.data.recipient;

  // recipient_type CHECK aceita só 'chat'|'group' ou NULL — nosso schema
  // garante isso via Zod no edge, mas defensive: coalesce.
  const recipientType: 'chat' | 'group' | null =
    r.type === 'chat' || r.type === 'group' ? r.type : null;

  // Texto da mensagem — pode estar em `m.text` (se `type='text'`); para outros
  // tipos (audio/image/etc.) fica null aqui. `media_url` é preenchido a partir
  // de `m.media.url` quando presente (Bloco 12 — áudio).
  const text = m.text ?? null;
  const mediaUrl = m.media?.url ?? null;

  // INSERT com ON CONFLICT DO NOTHING + RETURNING id.
  //
  // Usamos SQL bruto via Drizzle (db.execute) porque a sintaxe
  // `ON CONFLICT (col) WHERE predicate` precisa ser EXATA — preferimos
  // não depender de helpers do builder que poderiam não emitir o WHERE.
  //
  // Repetição CRÍTICA do `WHERE zapster_message_id IS NOT NULL` (learn
  // `on-conflict-em-indice-parcial`).
  const insertResult = await db.execute<{ id: string }>(sql`
    INSERT INTO messages (
      contact_id, lead_id, direction, role,
      zapster_message_id, recipient_id, recipient_type,
      text, media_type, media_url
    )
    VALUES (
      ${contactId}, ${leadId}, 'INBOUND', 'user',
      ${m.id}, ${r.id}, ${recipientType},
      ${text}, ${m.type === 'text' ? null : m.type}, ${mediaUrl}
    )
    ON CONFLICT (zapster_message_id) WHERE zapster_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `);

  // postgres-js retorna um array; rowCount == 0 indica conflito.
  const inserted = Array.from(insertResult) as Array<{ id: string }>;
  if (inserted.length > 0) {
    return { messageId: inserted[0].id, isDuplicate: false };
  }

  // Duplicata — busca o id já existente.
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM messages
    WHERE zapster_message_id = ${m.id}
    LIMIT 1
  `);
  const existingRows = Array.from(existing) as Array<{ id: string }>;
  if (existingRows.length === 0) {
    // Edge case: alguém deletou a mensagem entre as duas queries.
    // Tratamos como erro fatal — quem chamou decide o que fazer.
    throw new Error(
      `claimMessage: ON CONFLICT skipped insert but SELECT found no existing row for zapster_message_id=${m.id}`,
    );
  }
  return { messageId: existingRows[0].id, isDuplicate: true };
}
