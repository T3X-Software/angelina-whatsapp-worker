// src/utils/agent-media.ts
//
// Feature 1.9 — helpers PUROS da tool `select_media` (ADR 0003). Sem IO (a query
// fica na tool) para ser testável por smoke.

export interface SelectMediaInput {
  category?: string;
  event_type?: string;
  limit?: number;
}

export interface NormalizedSelectMedia {
  category: string | null;
  event_type: string | null;
  limit: number;
}

export const SELECT_MEDIA_DEFAULT_LIMIT = 5;
export const SELECT_MEDIA_MAX_LIMIT = 10;

/**
 * Normaliza o input: trim de filtros (vazio → null), clamp do limit em
 * [1, 10] com default 5. Defensivo contra valores malformados do LLM.
 */
export function normalizeSelectMediaInput(
  input: SelectMediaInput,
): NormalizedSelectMedia {
  const cat = input.category?.trim();
  const ev = input.event_type?.trim();
  let limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : SELECT_MEDIA_DEFAULT_LIMIT;
  if (limit < 1) limit = SELECT_MEDIA_DEFAULT_LIMIT;
  if (limit > SELECT_MEDIA_MAX_LIMIT) limit = SELECT_MEDIA_MAX_LIMIT;
  return {
    category: cat && cat.length > 0 ? cat : null,
    event_type: ev && ev.length > 0 ? ev : null,
    limit,
  };
}

// `type` (não interface) para satisfazer o constraint de `db.execute<T>`.
export type AgentMediaRow = {
  id: string;
  title: string | null;
  category: string | null;
  event_type: string | null;
  public_url: string;
  media_type: string;
  mime_type: string | null;
};

export interface AgentMediaEntry {
  id: string;
  title: string | null;
  media_type: string;
  url: string;
  category: string | null;
  event_type: string | null;
  mime_type: string | null;
}

/** Mapeia uma linha de `agent_media` para a saída da tool (renomeia public_url→url). */
export function mapMediaRow(r: AgentMediaRow): AgentMediaEntry {
  return {
    id: r.id,
    title: r.title,
    media_type: r.media_type,
    url: r.public_url,
    category: r.category,
    event_type: r.event_type,
    mime_type: r.mime_type,
  };
}
