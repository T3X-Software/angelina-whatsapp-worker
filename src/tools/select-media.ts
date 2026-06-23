// src/tools/select-media.ts
//
// Feature 1.9 (ADR 0003) — Tool `select_media`. READ-ONLY.
//
// Responsabilidade:
//   - Consultar `agent_media` (published=true, filtros opcionais por
//     category/event_type) e RETORNAR a(s) mídia(s) escolhida(s) no ToolResult.
//   - NÃO envia (invariante 4) e NÃO muta ctx. Quem envia é o hook `media-sender`
//     (Commit 2): o loop acumula a seleção em `ctx.pendingMedia`.
//
// Invariantes:
//   - INVARIANTE 3: NÃO chama LLM.
//   - INVARIANTE 4: NÃO envia mensagem.
//
// `agent_media` não está no schema gerado (db:pull defasado) — query via SQL raw,
// mesmo padrão de check-blocked-dates.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/client';
import type { HarnessContext, Tool, ToolResult } from '../harness/types';
import {
  normalizeSelectMediaInput,
  mapMediaRow,
  type AgentMediaRow,
  type AgentMediaEntry,
} from '../utils/agent-media';

const inputSchema = z
  .object({
    category: z.string().max(100).optional(),
    event_type: z.string().max(100).optional(),
    limit: z.number().int().optional(),
  })
  .strict();

type SelectMediaInputT = z.infer<typeof inputSchema>;

interface SelectMediaOutput {
  count: number;
  media: AgentMediaEntry[];
}

async function execute(
  input: SelectMediaInputT,
  _ctx: HarnessContext,
): Promise<ToolResult<SelectMediaOutput>> {
  const n = normalizeSelectMediaInput(input);
  try {
    const rows = await db.execute<AgentMediaRow>(sql`
      SELECT id::text   AS id,
             title,
             category,
             event_type,
             public_url,
             media_type,
             mime_type
        FROM agent_media
       WHERE published = true
         AND (${n.category}::text IS NULL OR category = ${n.category})
         AND (${n.event_type}::text IS NULL OR event_type = ${n.event_type})
       ORDER BY created_at DESC
       LIMIT ${n.limit}
    `);
    const arr = Array.from(rows) as AgentMediaRow[];
    const media = arr.map(mapMediaRow);
    return { success: true, data: { count: media.length, media } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export const selectMediaTool: Tool<SelectMediaInputT, SelectMediaOutput> = {
  name: 'select_media',
  description:
    'Seleciona fotos/vídeos/PDFs do espaço para enviar ao cliente quando ele ' +
    'pede para ver imagens, o cardápio, a estrutura, etc. Filtre por `category` ' +
    '(ex: "salao", "gastronomia", "estrutura") e/ou `event_type` (ex: ' +
    '"casamento", "aniversario") quando fizer sentido. Esta tool apenas ESCOLHE ' +
    'a mídia — o envio acontece automaticamente depois. Não chame se o cliente ' +
    'não pediu para ver mídia.',
  inputSchema,
  execute,
};
