// src/tools/check-blocked-dates.ts
//
// Feature 1.11 — Tool `check_blocked_dates`. READ-ONLY.
//
// Responsabilidade:
//   - Consultar `blocked_dates` para uma data (ou intervalo) ANTES de a Angelina
//     sugerir/confirmar uma visita ou data de evento.
//   - Retornar os bloqueios (dia inteiro OU faixa de horário) + motivo.
//
// Invariantes:
//   - INVARIANTE 3: NÃO chama LLM.
//   - INVARIANTE 4: NÃO envia mensagem — só lê e retorna ao Claude.
//
// `blocked_dates` não está no schema gerado (db:pull defasado) — query via SQL
// raw, mesmo padrão de classify-lead/transfer-trigger.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/client';
import type { HarnessContext, Tool, ToolResult } from '../harness/types';
import {
  resolveBlockedDatesRange,
  mapBlockedRow,
  type BlockedDateRow,
  type BlockedDateEntry,
} from '../utils/blocked-dates';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z
  .object({
    date: z.string().regex(DATE_RE).optional(),
    start_date: z.string().regex(DATE_RE).optional(),
    end_date: z.string().regex(DATE_RE).optional(),
  })
  .strict();

type CheckBlockedDatesInput = z.infer<typeof inputSchema>;

interface CheckBlockedDatesOutput {
  any_blocked: boolean;
  blocks: BlockedDateEntry[];
}

async function execute(
  input: CheckBlockedDatesInput,
  _ctx: HarnessContext,
): Promise<ToolResult<CheckBlockedDatesOutput>> {
  const range = resolveBlockedDatesRange(input);
  if ('error' in range) {
    return { success: false, error: range.error };
  }

  try {
    const rows = await db.execute<BlockedDateRow>(sql`
      SELECT date::text       AS date,
             start_time::text AS start_time,
             end_time::text   AS end_time,
             reason
        FROM blocked_dates
       WHERE date >= ${range.start}::date
         AND date <= ${range.end}::date
       ORDER BY date ASC, start_time ASC NULLS FIRST
    `);
    const arr = Array.from(rows) as BlockedDateRow[];
    const blocks = arr.map(mapBlockedRow);

    return {
      success: true,
      data: { any_blocked: blocks.length > 0, blocks },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export const checkBlockedDatesTool: Tool<
  CheckBlockedDatesInput,
  CheckBlockedDatesOutput
> = {
  name: 'check_blocked_dates',
  description:
    'Consulta a agenda do espaço para ver se uma data (ou intervalo) tem ' +
    'bloqueios ANTES de sugerir ou confirmar uma visita/evento. Passe `date` ' +
    '(YYYY-MM-DD) para um dia, ou `start_date`+`end_date` para um intervalo. ' +
    'Retorna os bloqueios encontrados (dia inteiro ou faixa de horário) com o ' +
    'motivo. Chame sempre que o cliente mencionar uma data específica.',
  inputSchema,
  execute,
};
