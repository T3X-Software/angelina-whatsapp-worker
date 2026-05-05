// src/tools/classify-lead.ts
//
// Bloco 7 — Task 41. Tool `classify_lead`.
//
// Responsabilidade:
//   - Atualizar `leads.classification` (HOT / WARM / COLD).
//   - Registrar timeline_event com type='OTHER' (LEAD_UPDATED já é usado por
//     save_lead_info; OTHER + título distinto fica claro no painel).
//   - NÃO cria lead implicitamente — se ctx.lead===null, retorna erro
//     pedindo para o LLM chamar save_lead_info primeiro.
//   - NÃO dispara handoff. Quem dispara é a tool transfer_to_human OU o
//     hook transfer-trigger via regra `classification='HOT' + 3 dados`.
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
    classification: z.enum(['HOT', 'WARM', 'COLD']),
    reason: z.string().max(500).optional(),
  })
  .strict();

type ClassifyLeadInput = z.infer<typeof inputSchema>;

interface ClassifyLeadOutput {
  leadId: string;
  classification: 'HOT' | 'WARM' | 'COLD';
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

async function execute(
  input: ClassifyLeadInput,
  ctx: HarnessContext,
): Promise<ToolResult<ClassifyLeadOutput>> {
  if (ctx.lead === null) {
    // Não criamos lead implicitamente — disciplina explícita do brief.
    return {
      success: false,
      error: 'no_active_lead — call save_lead_info first',
    };
  }

  const leadId = ctx.lead.id;

  try {
    await db.transaction(async (tx) => {
      // UPDATE classification.
      await tx.execute(sql`
        UPDATE leads
           SET classification = ${input.classification}::lead_score
         WHERE id = ${leadId}
      `);

      // INSERT timeline_event. type='OTHER' + título distinto.
      const tlMetadata = {
        classification: input.classification,
        reason: input.reason ?? null,
        source: 'tool:classify_lead',
      };
      await tx.execute(sql`
        INSERT INTO timeline_events (
          contact_id, lead_id, type, title, description, metadata, created_by_id
        ) VALUES (
          ${ctx.contact.id},
          ${leadId},
          ${'OTHER'}::timeline_event_type,
          ${'Classificação atualizada via tool classify_lead'},
          ${input.reason ?? null},
          ${JSON.stringify(tlMetadata)}::jsonb,
          NULL
        )
      `);
    });

    // Atualiza ctx.lead.classification para o hook transfer-trigger
    // (ramo b, Bloco 6) e iterações futuras do mesmo turno.
    ctx.lead.classification = input.classification;

    return {
      success: true,
      data: {
        leadId,
        classification: input.classification,
        reason: input.reason,
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

export const classifyLeadTool: Tool<ClassifyLeadInput, ClassifyLeadOutput> = {
  name: 'classify_lead',
  description:
    'Classifica o lead como HOT (cliente quase fechando — pediu orçamento, ' +
    'visita ou mostrou intenção clara), WARM (engajado mas ainda em descoberta) ' +
    'ou COLD (apenas pesquisando). NÃO chama esta tool antes de ter pelo menos ' +
    'um dado básico do evento — chame save_lead_info primeiro. NÃO dispara ' +
    'transferência para humano: para isso use transfer_to_human.',
  inputSchema,
  execute,
};
