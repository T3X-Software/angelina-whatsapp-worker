// src/tools/save-lead-info.ts
//
// Bloco 7 — Task 40. Tool `save_lead_info`.
//
// Responsabilidade:
//   - Persistir dados estruturados do lead (event_type, event_date,
//     guest_count, estimated_budget, preferences, notes).
//   - Se `ctx.lead === null`, CRIA um lead novo na coluna ENTRY do pipeline
//     (auto-criação no primeiro save_lead_info, conforme decisão Q9 do brief).
//   - Senão, UPDATE no lead existente (apenas campos não-undefined).
//   - INSERT em `timeline_events` (type='LEAD_UPDATED') com metadata para
//     auditoria e UI futura.
//   - Atualiza `ctx.lead` para que iterações seguintes do mesmo turno
//     vejam o leadId (caso o LLM chame classify_lead em sequência).
//
// Invariantes:
//   - INVARIANTE 4: NÃO envia mensagem (não importa ZapsterClient).
//   - INVARIANTE 3: NÃO chama LLM.
//
// Decisões (Bloco 7):
//   - `timeline_events.type = 'LEAD_UPDATED'` para AMBOS os caminhos
//     (criação e update). Razão: o enum tem `LEAD_CREATED`, mas usá-lo
//     duplicaria com a CRM web que dispara LEAD_CREATED via UI;
//     a IA SEMPRE registra como UPDATED + título distinto + metadata.source
//     para diferenciar no painel.
//   - `timeline_events.created_by_id = NULL` (system) — mesma estratégia
//     do hook transfer-trigger (Bloco 6).
//   - Tudo dentro de `db.transaction` para que UPDATE+INSERT (ou INSERT+
//     INSERT no caso de criação) sejam atômicos. Se o INSERT do
//     timeline_events falhar, revertemos o lead.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/client';
import type { HarnessContext, Tool, ToolResult } from '../harness/types';

// ─────────────────────────────────────────────────────────────────────────────
// Input schema (Zod, strict)
// ─────────────────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    event_type: z
      .enum([
        'WEDDING',
        'BIRTHDAY',
        'CORPORATE',
        'GRADUATION',
        'SWEET_FIFTEEN',
        'OTHER',
      ])
      .optional(),
    event_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'event_date must be ISO date YYYY-MM-DD')
      .optional(),
    guest_count: z.number().int().min(1).max(10000).optional(),
    estimated_budget: z.number().positive().optional(),
    preferences: z.string().max(2000).optional(),
    notes: z.string().max(2000).optional(),
    /** Nome do cliente. Quando preenchido, atualiza `contacts.name`.
     *  Use ao receber o nome real do cliente para substituir o placeholder
     *  `WhatsApp <phone>` da auto-criação. */
    contact_name: z.string().min(1).max(200).optional(),
    /** UUID do lead alvo. Use APENAS quando há múltiplos leads abertos para
     *  o contato e o cliente já desambiguou — passe o ID do lead escolhido
     *  para que a atualização seja aplicada no lead correto. Se omitido,
     *  o tool atualiza o lead vinculado ao turno (ou cria um novo se nenhum
     *  estiver vinculado). */
    lead_id: z.string().uuid().optional(),
  })
  .strict();

type SaveLeadInfoInput = z.infer<typeof inputSchema>;

interface SaveLeadInfoOutput {
  leadId: string;
  fieldsUpdated: string[];
  contactNameUpdated: boolean;
  created: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: monta SET clause dinâmica para UPDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filtra os fields que vieram não-undefined no input. Retorna um array de
 * `{column, value}` para usar em INSERT ou UPDATE.
 *
 * Decisão: ignora `null` explícito (o LLM não deveria mandar null; manda
 * `undefined`/omite). Se isso virar um problema, ajustamos o schema Zod
 * para aceitar `nullable` em casos específicos.
 */
function collectFields(input: SaveLeadInfoInput): Array<{
  column: string;
  value: string | number;
}> {
  const out: Array<{ column: string; value: string | number }> = [];
  if (input.event_type !== undefined) {
    out.push({ column: 'event_type', value: input.event_type });
  }
  if (input.event_date !== undefined) {
    out.push({ column: 'event_date', value: input.event_date });
  }
  if (input.guest_count !== undefined) {
    out.push({ column: 'guest_count', value: input.guest_count });
  }
  if (input.estimated_budget !== undefined) {
    out.push({ column: 'estimated_budget', value: input.estimated_budget });
  }
  if (input.preferences !== undefined) {
    out.push({ column: 'preferences', value: input.preferences });
  }
  if (input.notes !== undefined) {
    out.push({ column: 'notes', value: input.notes });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

async function execute(
  input: SaveLeadInfoInput,
  ctx: HarnessContext,
): Promise<ToolResult<SaveLeadInfoOutput>> {
  const fields = collectFields(input);
  const fieldNames = fields.map((f) => f.column);
  const wantsContactName =
    typeof input.contact_name === 'string' && input.contact_name.trim().length > 0;

  // Resolução do lead alvo:
  //   1. `input.lead_id` → UPDATE no lead específico (após validar dono).
  //      Usado quando há múltiplos leads ativos e o cliente desambiguou.
  //   2. `ctx.lead` setado → UPDATE no lead vinculado ao turno (caso atual).
  //   3. Nenhum dos dois → CREATE novo lead na coluna ENTRY.
  const targetLeadId: string | null = input.lead_id ?? ctx.lead?.id ?? null;

  try {
    const result = await db.transaction(async (tx) => {
      // ── Atualização do nome do contato (independe do lead) ─────────────
      if (wantsContactName) {
        await tx.execute(sql`
          UPDATE contacts SET name = ${input.contact_name!.trim()}
           WHERE id = ${ctx.contact.id}
        `);
      }

      let leadId: string;
      let created = false;

      if (targetLeadId !== null) {
        // ── UPDATE lead existente ────────────────────────────────────────
        // Quando vier `input.lead_id`, valida que o lead pertence ao contato
        // do turno (defesa contra LLM passando ID errado).
        if (input.lead_id !== undefined) {
          const ownerRows = await tx.execute<{ contact_id: string }>(sql`
            SELECT contact_id::text AS contact_id
              FROM leads
             WHERE id = ${input.lead_id}
             LIMIT 1
          `);
          const ownerArr = Array.from(ownerRows) as Array<{ contact_id: string }>;
          if (ownerArr.length === 0) {
            throw new Error(
              `save_lead_info: lead_id=${input.lead_id} não encontrado`,
            );
          }
          if (ownerArr[0].contact_id !== ctx.contact.id) {
            throw new Error(
              `save_lead_info: lead_id=${input.lead_id} não pertence ao contato do turno`,
            );
          }
        }
        leadId = targetLeadId;

        if (fields.length > 0) {
          // Monta SET dinâmico só com os fields que vieram.
          const setParts: ReturnType<typeof sql>[] = [];
          if (input.event_type !== undefined) {
            setParts.push(sql`event_type = ${input.event_type}::event_type`);
          }
          if (input.event_date !== undefined) {
            setParts.push(sql`event_date = ${input.event_date}::date`);
          }
          if (input.guest_count !== undefined) {
            setParts.push(sql`guest_count = ${input.guest_count}`);
          }
          if (input.estimated_budget !== undefined) {
            setParts.push(sql`estimated_budget = ${input.estimated_budget}`);
          }
          if (input.preferences !== undefined) {
            setParts.push(sql`preferences = ${input.preferences}`);
          }
          if (input.notes !== undefined) {
            setParts.push(sql`notes = ${input.notes}`);
          }
          // updated_at é mantido via trigger no banco (defaults now()).
          const setClause = sql.join(setParts, sql.raw(', '));
          await tx.execute(sql`
            UPDATE leads SET ${setClause} WHERE id = ${leadId}
          `);
        }
        // Se nenhum field veio, ainda gravamos timeline_event marcando
        // a chamada (auditoria), mas sem mexer no lead.
      } else {
        // ── Criar lead novo ──────────────────────────────────────────────
        // Lookup ENTRY column (config faltando = erro de setup).
        const entryRows = await tx.execute<{ id: string }>(sql`
          SELECT id FROM pipeline_columns
           WHERE type = 'ENTRY'
           ORDER BY position ASC
           LIMIT 1
        `);
        const entryArr = Array.from(entryRows) as Array<{ id: string }>;
        if (entryArr.length === 0) {
          throw new Error(
            'save_lead_info: no pipeline_columns row with type=ENTRY found — config missing',
          );
        }
        const entryId = entryArr[0].id;

        // INSERT leads. `classification` tem default 'COLD'; `status`
        // default 'OPEN'; `is_human_active` default false. Para os
        // 6 fields do input, montamos a INSERT lista dinamicamente.
        const baseCols = sql`(contact_id, pipeline_column_id, status, origin`;
        const baseVals = sql`(${ctx.contact.id}, ${entryId}, 'OPEN'::lead_status_enum, 'WHATSAPP'`;

        // Monta as partes opcionais.
        const colParts: ReturnType<typeof sql>[] = [];
        const valParts: ReturnType<typeof sql>[] = [];
        if (input.event_type !== undefined) {
          colParts.push(sql`event_type`);
          valParts.push(sql`${input.event_type}::event_type`);
        }
        if (input.event_date !== undefined) {
          colParts.push(sql`event_date`);
          valParts.push(sql`${input.event_date}::date`);
        }
        if (input.guest_count !== undefined) {
          colParts.push(sql`guest_count`);
          valParts.push(sql`${input.guest_count}`);
        }
        if (input.estimated_budget !== undefined) {
          colParts.push(sql`estimated_budget`);
          valParts.push(sql`${input.estimated_budget}`);
        }
        if (input.preferences !== undefined) {
          colParts.push(sql`preferences`);
          valParts.push(sql`${input.preferences}`);
        }
        if (input.notes !== undefined) {
          colParts.push(sql`notes`);
          valParts.push(sql`${input.notes}`);
        }

        const cols =
          colParts.length > 0
            ? sql`${baseCols}, ${sql.join(colParts, sql.raw(', '))})`
            : sql`${baseCols})`;
        const vals =
          valParts.length > 0
            ? sql`${baseVals}, ${sql.join(valParts, sql.raw(', '))})`
            : sql`${baseVals})`;

        const insertedRows = await tx.execute<{ id: string }>(sql`
          INSERT INTO leads ${cols} VALUES ${vals}
          RETURNING id
        `);
        const insertedArr = Array.from(insertedRows) as Array<{ id: string }>;
        if (insertedArr.length === 0) {
          throw new Error('save_lead_info: lead INSERT returned no rows');
        }
        leadId = insertedArr[0].id;
        created = true;
      }

      // ── INSERT timeline_events ─────────────────────────────────────────
      const tlMetadata = {
        fields: input,
        source: 'tool:save_lead_info',
        created_lead: created,
        contact_name_updated: wantsContactName,
      };
      const tlTitle = created
        ? 'Lead criado via tool save_lead_info'
        : 'Lead atualizado via tool save_lead_info';
      await tx.execute(sql`
        INSERT INTO timeline_events (
          contact_id, lead_id, type, title, description, metadata, created_by_id
        ) VALUES (
          ${ctx.contact.id},
          ${leadId},
          ${'LEAD_UPDATED'}::timeline_event_type,
          ${tlTitle},
          ${null},
          ${JSON.stringify(tlMetadata)}::jsonb,
          NULL
        )
      `);

      return { leadId, created };
    });

    // Mutações em memória para próximas iterações do MESMO turno.
    if (wantsContactName) {
      ctx.contact.name = input.contact_name!.trim();
    }
    // Bind ctx.lead ao alvo (criado, ou desambiguado via lead_id, ou já o
    // próprio ctx.lead — em todos os casos espelha `result.leadId`).
    if (ctx.lead === null || ctx.lead.id !== result.leadId) {
      ctx.lead = {
        id: result.leadId,
        isHumanActive: ctx.lead?.isHumanActive ?? false,
        classification: ctx.lead?.classification ?? null,
        eventType: input.event_type ?? ctx.lead?.eventType ?? null,
        eventDate: input.event_date ?? ctx.lead?.eventDate ?? null,
        guestCount: input.guest_count ?? ctx.lead?.guestCount ?? null,
        estimatedBudget:
          input.estimated_budget !== undefined
            ? String(input.estimated_budget)
            : ctx.lead?.estimatedBudget ?? null,
        preferences: input.preferences ?? ctx.lead?.preferences ?? null,
        notes: input.notes ?? ctx.lead?.notes ?? null,
        visitScheduledAt: ctx.lead?.visitScheduledAt ?? null,
      };
    } else {
      // Mesmo lead: apenas atualiza campos que vieram no input.
      if (input.event_type !== undefined) ctx.lead.eventType = input.event_type;
      if (input.event_date !== undefined) ctx.lead.eventDate = input.event_date;
      if (input.guest_count !== undefined) ctx.lead.guestCount = input.guest_count;
      if (input.estimated_budget !== undefined) {
        ctx.lead.estimatedBudget = String(input.estimated_budget);
      }
      if (input.preferences !== undefined) ctx.lead.preferences = input.preferences;
      if (input.notes !== undefined) ctx.lead.notes = input.notes;
    }

    return {
      success: true,
      data: {
        leadId: result.leadId,
        fieldsUpdated: fieldNames,
        contactNameUpdated: wantsContactName,
        created: result.created,
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

export const saveLeadInfoTool: Tool<SaveLeadInfoInput, SaveLeadInfoOutput> = {
  name: 'save_lead_info',
  description:
    'Salva dados estruturados do lead (tipo de evento, data, número de convidados, ' +
    'orçamento estimado, preferências, notas) e/ou o nome do contato. Cria um lead ' +
    'novo na coluna ENTRY do pipeline se nenhum estiver vinculado ao turno; senão ' +
    'atualiza o lead vinculado. Quando passar `lead_id`, atualiza esse lead específico ' +
    '— use isso APENAS depois que o cliente desambiguar entre múltiplos leads abertos. ' +
    'Quando passar `contact_name`, atualiza `contacts.name` (use ao receber o nome real ' +
    'do cliente, substituindo o placeholder `WhatsApp <phone>`). ' +
    'Use sempre que o cliente fornecer ao menos um dado novo do evento, do nome, ou ' +
    'desambiguar o lead.',
  inputSchema,
  execute,
};
