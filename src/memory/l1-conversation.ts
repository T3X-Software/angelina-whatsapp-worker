// src/memory/l1-conversation.ts
//
// Bloco 10 — Task 51.
//
// L1 = "lastN(15)" — últimas N mensagens do contato, em ordem cronológica,
// já mapeadas para o formato `LLMMessage` do nosso LLM client (`src/llm/types.ts`),
// que por sua vez é compatível com `MessageParam` do `@anthropic-ai/sdk`.
//
// Decisões / convenções:
//   - Filtro LGPD: `WHERE redacted_at IS NULL` exclui mensagens redatadas
//     (operador apagou) — concept `memory-layers`.
//   - Ordenamos `created_at DESC LIMIT N` e fazemos `reverse()` no JS para
//     pegar as N MAIS RECENTES e devolvê-las em ordem cronológica
//     (ascendente) — Anthropic exige ordem temporal.
//   - Mapeamento por `role`:
//       'user'      → { role:'user',      content: text }
//       'assistant' (text)      → { role:'assistant', content: text }
//       'assistant' (tool_use)  → { role:'assistant', content: [{type:'tool_use',...}] }
//       'tool'      → { role:'user',      content: [{type:'tool_result',...}] }
//     (Anthropic SDK exige tool_result em mensagem com role='user'.)
//   - Outbounds com `send_status` em ('pending','failed') NÃO são úteis como
//     histórico (ou nunca chegaram ao cliente, ou são state intermediário) —
//     filtramos no JS após a query (mantém a query simples, índice usa contactId
//     + redacted_at).
//   - tool_use_id: o schema `messages` NÃO tem `tool_use_id` próprio. Derivamos
//     `toolu_<messageId>` (uuid do INSERT). É determinístico — se a mesma
//     conversa for replayed, gera o mesmo id.

import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import type {
  LLMContentBlock,
  LLMMessage,
  LLMToolResultBlock,
  LLMToolUseBlock,
} from '../llm/types';

/**
 * Linha "raw" lida do `messages` para o L1.
 *
 * `created_at` retorna como string (ISO) via `db.execute<>` raw — não usamos
 * ela depois (a ordem já está garantida pela query); deixamos tipada para
 * documentar o shape.
 */
interface RawMessageRow {
  id: string;
  direction: string;
  role: string;
  text: string | null;
  tool_name: string | null;
  tool_args: unknown;
  tool_result: unknown;
  /** FK para o tool_use (assistant) que originou este tool_result. NULL para outras rows. */
  tool_use_message_id: string | null;
  send_status: string | null;
  created_at: string;
  [key: string]: unknown; // satisfaz constraint do db.execute<>
}

/**
 * Retorna as últimas `n` mensagens do contato em ordem cronológica,
 * prontas para virar `messages` no payload do Anthropic SDK.
 *
 * Vazio é resultado válido (contato novo / sem histórico). Quem chama
 * (`composer.compose`) decide o que fazer.
 */
export async function loadLastN(
  contactId: string,
  n: number = 15,
): Promise<LLMMessage[]> {
  // SELECT cru — postgres-js retorna rows iteráveis em `Result`.
  const result = await db.execute<RawMessageRow>(sql`
    SELECT id::text                  AS id,
           direction::text           AS direction,
           role::text                AS role,
           text,
           tool_name,
           tool_args,
           tool_result,
           tool_use_message_id::text AS tool_use_message_id,
           send_status::text         AS send_status,
           created_at::text          AS created_at
      FROM messages
     WHERE contact_id    = ${contactId}
       AND redacted_at IS NULL
     ORDER BY created_at DESC
     LIMIT ${n}
  `);

  // Result -> array, em ordem cronológica ASC.
  const rows = Array.from(result).reverse();

  const out: LLMMessage[] = [];

  for (const row of rows) {
    // Outbounds não-`sent` não viraram conversa de fato → pula.
    if (
      row.direction === 'OUTBOUND' &&
      row.send_status !== null &&
      row.send_status !== 'sent'
    ) {
      continue;
    }

    const mapped = mapRowToLLMMessage(row);
    if (mapped) out.push(mapped);
  }

  return out;
}

/**
 * Aplica o mapeamento role→LLMMessage. Retorna `null` se a linha não tem
 * conteúdo útil (ex: assistant sem text e sem tool_name).
 */
function mapRowToLLMMessage(row: RawMessageRow): LLMMessage | null {
  switch (row.role) {
    case 'user': {
      // Inbound do cliente (texto). Se text NULL/vazio, pula
      // (áudio sem transcrição não vai como turno de conversa para o LLM).
      const text = (row.text ?? '').trim();
      if (text.length === 0) return null;
      return { role: 'user', content: text };
    }

    case 'assistant': {
      // Caso 1: assistant respondeu com texto (sem tool_use).
      if (row.text && row.text.trim().length > 0 && !row.tool_name) {
        return { role: 'assistant', content: row.text };
      }
      // Caso 2: assistant chamou tool. Reconstruímos um content array com
      // (text opcional) + tool_use.
      if (row.tool_name) {
        const blocks: LLMContentBlock[] = [];
        if (row.text && row.text.trim().length > 0) {
          blocks.push({ type: 'text', text: row.text });
        }
        const toolUse: LLMToolUseBlock = {
          type: 'tool_use',
          id: deriveToolUseId(row.id),
          name: row.tool_name,
          input: row.tool_args ?? {},
        };
        blocks.push(toolUse);
        return { role: 'assistant', content: blocks };
      }
      // Assistant sem text e sem tool_name — nada útil.
      return null;
    }

    case 'tool': {
      // Resultado de tool — Anthropic exige role='user' com tool_result block.
      if (!row.tool_name) return null;
      // Pareamento explícito (Bloco 6.5, fix bug #5): tool_use_message_id
      // aponta para a row INBOUND assistant que emitiu este tool_use. O id
      // dessa row é usado para derivar o `tool_use_id` que o Anthropic SDK
      // exige correlacionar entre o assistant block e este tool_result.
      // Fallback (rows antigas pré-migration / persistência da row tool_use
      // falhou): deriva do próprio row.id — no melhor caso quebra cross-turn,
      // mas mantém compat.
      const anchorId = row.tool_use_message_id ?? row.id;
      const block: LLMToolResultBlock = {
        type: 'tool_result',
        tool_use_id: deriveToolUseId(anchorId),
        content:
          row.tool_result !== null && row.tool_result !== undefined
            ? safeJsonStringify(row.tool_result)
            : '{"success":false,"error":"no_result"}',
      };
      return { role: 'user', content: [block] };
    }

    default:
      // role desconhecida — defensive, ignora.
      return null;
  }
}

function deriveToolUseId(messageId: string): string {
  // Anthropic exige id começando com letra; `toolu_` é a convenção visual
  // que o próprio SDK usa quando emite tool_use.
  return `toolu_${messageId.replace(/-/g, '').slice(0, 22)}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
