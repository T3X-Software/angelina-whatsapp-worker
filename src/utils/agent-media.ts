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

// ─────────────────────────────────────────────────────────────────────────────
// Commit 2 (ADR 0003) — acumulação + gate do hook media-sender
// ─────────────────────────────────────────────────────────────────────────────

/** Mídia pronta para o hook `media-sender` enviar. */
export interface MediaToSend {
  id: string;
  url: string;
  caption?: string;
  media_type: string;
}

/**
 * Acumula as mídias escolhidas pelos tool calls `select_media` do turno em uma
 * lista de envio (PURA). Deduplica por `id`. `caption` = título da mídia.
 */
export function collectPendingMedia(
  toolResults: ReadonlyArray<{
    name: string;
    result: { success: boolean; data?: unknown };
  }>,
): MediaToSend[] {
  const out: MediaToSend[] = [];
  const seen = new Set<string>();
  for (const tc of toolResults) {
    if (tc.name !== 'select_media' || tc.result.success !== true) continue;
    const data = tc.result.data as { media?: AgentMediaEntry[] } | undefined;
    for (const m of data?.media ?? []) {
      if (!m || !m.url || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({
        id: m.id,
        url: m.url,
        caption: m.title ?? undefined,
        media_type: m.media_type,
      });
    }
  }
  return out;
}

/**
 * Gate do `media-sender` (PURA): NÃO envia mídia se o humano assumiu o
 * atendimento — `leads.is_human_active=true` OU `contacts.ai_state` pausado
 * (`PAUSED`/`HUMAN_TAKEOVER`). `AUTO` e `AFTER_HOURS_OK` permitem envio.
 */
export function canSendMedia(
  isHumanActive: boolean | undefined,
  aiState: string | undefined,
): boolean {
  if (isHumanActive === true) return false;
  if (aiState === 'PAUSED' || aiState === 'HUMAN_TAKEOVER') return false;
  return true;
}
