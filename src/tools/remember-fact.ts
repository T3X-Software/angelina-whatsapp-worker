// src/tools/remember-fact.ts
//
// Bloco 7 — Task 43. Tool `remember_fact`.
//
// Aplica o concept `append-only-facts`:
//   - SELECT existing fact ativo (mesmo contact_id + fact_type AND
//     superseded_by IS NULL).
//   - INSERT nova fact SEMPRE (mesmo se for o "primeiro" fato do tipo).
//   - Se existing existia: UPDATE old.superseded_by = new.id
//     → executado dentro da MESMA transação Drizzle, atomic.
//
// Estratégia anti-race:
//   - O índice parcial `contact_facts_active_high_conf_idx WHERE superseded_by
//     IS NULL` NÃO é UNIQUE (verificado via SQL ao vivo). Então o banco não
//     enforce 1-ativa-por-tipo — a aplicação faz.
//   - Para evitar race entre dois turnos chamando remember_fact ao mesmo tempo
//     no mesmo contact+fact_type, usamos `SELECT ... FOR UPDATE` na linha
//     ativa existente (lock pessimista). A transação inteira (SELECT FOR
//     UPDATE → INSERT new → UPDATE old) garante que dois callers serializem.
//
// Source tracking:
//   - `source = 'tool:remember_fact'` (literal).
//   - `source_msg_id = ctx.message.inboundId` (uuid do INSERT inbound do
//     turno corrente — do Bloco 5 task 28 idempotency.claimMessage).
//
// NUNCA UPDATE de `fact_value` ou `confidence` em row existente — sempre
// INSERT nova + supersede antiga (regra append-only).
//
// Invariantes:
//   - INVARIANTE 4: NÃO envia mensagem.
//   - INVARIANTE 3: NÃO chama LLM.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/client';
import type { HarnessContext, Tool, ToolResult } from '../harness/types';

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    fact_type: z.string().min(1).max(80),
    fact_value: z.record(z.string(), z.unknown()),
    confidence: z.number().min(0).max(1),
    expires_at: z.string().datetime().optional(),
  })
  .strict();

type RememberFactInput = z.infer<typeof inputSchema>;

interface RememberFactOutput {
  factId: string;
  supersededFactId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

async function execute(
  input: RememberFactInput,
  ctx: HarnessContext,
): Promise<ToolResult<RememberFactOutput>> {
  try {
    const result = await db.transaction(async (tx) => {
      // 1. Lookup existing fact ativo + lock para evitar race.
      const existingRows = await tx.execute<{ id: string }>(sql`
        SELECT id FROM contact_facts
         WHERE contact_id = ${ctx.contact.id}
           AND fact_type = ${input.fact_type}
           AND superseded_by IS NULL
         ORDER BY extracted_at DESC
         LIMIT 1
         FOR UPDATE
      `);
      const existingArr = Array.from(existingRows) as Array<{ id: string }>;
      const existingId = existingArr[0]?.id ?? null;

      // 2. INSERT new fact. fact_value é jsonb; confidence numeric(3,2);
      // expires_at timestamptz opcional. source/source_msg_id sempre setados.
      const insertedRows = await tx.execute<{ id: string }>(sql`
        INSERT INTO contact_facts (
          contact_id, fact_type, fact_value, confidence,
          source, source_msg_id, expires_at
        ) VALUES (
          ${ctx.contact.id},
          ${input.fact_type},
          ${JSON.stringify(input.fact_value)}::jsonb,
          ${input.confidence},
          ${'tool:remember_fact'},
          ${ctx.message.inboundId},
          ${input.expires_at ?? null}
        )
        RETURNING id
      `);
      const insertedArr = Array.from(insertedRows) as Array<{ id: string }>;
      if (insertedArr.length === 0) {
        throw new Error('remember_fact: INSERT returned no rows');
      }
      const newFactId = insertedArr[0].id;

      // 3. Supersede old (se existia). UPDATE dentro da mesma transação.
      if (existingId !== null) {
        await tx.execute(sql`
          UPDATE contact_facts
             SET superseded_by = ${newFactId}
           WHERE id = ${existingId}
             AND superseded_by IS NULL
        `);
      }

      return { newFactId, existingId };
    });

    return {
      success: true,
      data: {
        factId: result.newFactId,
        supersededFactId: result.existingId,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const rememberFactTool: Tool<RememberFactInput, RememberFactOutput> = {
  name: 'remember_fact',
  description:
    'Memoriza um fato relevante sobre o contato (preferência alimentar, ' +
    'restrição, data importante, contexto pessoal). ' +
    'Use fact_type curto e descritivo (ex: "preferencia_alimentar", ' +
    '"restricao", "data_aniversario"). fact_value é um objeto livre. ' +
    'Confidence: 0.0–1.0 (use 0.9+ se o cliente afirmou explicitamente; ' +
    '0.6–0.8 se inferiu). expires_at opcional (ISO timestamp). ' +
    'Esta tool é append-only: chamar de novo com o mesmo fact_type cria ' +
    'uma versão nova e arquiva a anterior automaticamente.',
  inputSchema,
  execute,
};
