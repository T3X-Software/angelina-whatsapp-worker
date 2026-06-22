// src/insights/transcript-renderer.ts
//
// Feature `conversation-insights`.
//
// Renderiza as mensagens de UMA conversa em texto plano legível pelo LLM
// analista, com um cabeçalho do desfecho do lead. Cada linha é prefixada com
// `[<id8>]` (8 primeiros chars do message_id) para o modelo poder citar as
// mensagens em `evidence.messageIds` — o analyst-core remapeia o prefixo para
// o uuid completo e valida.
//
// Filtra ruído: mensagens redigidas (`redactedAt`), vazias (sem texto/
// transcrição/tool) e mídia puramente decorativa sem transcrição. Trunca
// jsonb de tool e o transcript total (mantém as mensagens MAIS RECENTES).

export interface RenderableMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND' | string;
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  text: string | null;
  mediaType: string | null;
  transcription: string | null;
  toolName: string | null;
  toolArgs: unknown;
  toolResult: unknown;
  redactedAt: Date | string | null;
  createdAt: Date | string | null;
}

export interface LeadSnapshot {
  classification: string | null;
  eventType: string | null;
  eventDate: string | null;
  guestCount: number | null;
  status: string | null;
  isHumanActive: boolean | null;
  handoffAssumedAt: Date | string | null;
  interestSummary: string | null;
}

const TOOL_JSON_MAX = 240;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function summarizeJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length > TOOL_JSON_MAX) s = `${s.slice(0, TOOL_JSON_MAX)}…`;
  return s;
}

/**
 * Renderiza UMA linha do transcript. Retorna `null` quando a mensagem é ruído
 * a ser descartado.
 */
function renderLine(m: RenderableMessage): string | null {
  if (m.redactedAt) return null;

  const tag = `[${shortId(m.id)}]`;
  const role = m.role;

  // tool_result (role=tool)
  if (role === 'tool') {
    const name = m.toolName ?? '?';
    return `${tag} [resultado ${name}: ${summarizeJson(m.toolResult)}]`;
  }

  // assistant chamando tool (tool_use)
  if (role === 'assistant' && m.toolName) {
    return `${tag} [angelina chamou ${m.toolName}(${summarizeJson(m.toolArgs)})]`;
  }

  const text = (m.text ?? '').trim();
  const transcription = (m.transcription ?? '').trim();
  const body = text || transcription;

  // Sem corpo textual: só registra se houver mídia (com rótulo curto), senão descarta.
  if (!body) {
    if (m.mediaType) {
      const speaker = role === 'assistant' ? 'angelina' : 'cliente';
      return `${tag} [${speaker} enviou mídia: ${m.mediaType}]`;
    }
    return null;
  }

  const speaker = role === 'assistant' ? 'angelina' : 'cliente';
  return `${tag} [${speaker}] ${body}`;
}

function renderLeadHeader(lead: LeadSnapshot | null): string {
  if (!lead) return 'Lead: (nenhum lead vinculado a este contato)';
  const parts: string[] = [];
  if (lead.classification) parts.push(`classificação=${lead.classification}`);
  if (lead.status) parts.push(`status=${lead.status}`);
  if (lead.eventType) parts.push(`tipo=${lead.eventType}`);
  if (lead.eventDate) parts.push(`data=${lead.eventDate}`);
  if (lead.guestCount !== null && lead.guestCount !== undefined) {
    parts.push(`convidados=${lead.guestCount}`);
  }
  if (lead.isHumanActive) {
    parts.push(
      lead.handoffAssumedAt
        ? 'handoff=assumido por humano'
        : 'handoff=disparado mas NÃO assumido por humano',
    );
  }
  const detail = parts.length > 0 ? parts.join(', ') : 'sem dados qualificadores';
  const interest = lead.interestSummary
    ? `\nResumo do interesse (snapshot do handoff): ${lead.interestSummary}`
    : '';
  return `Desfecho do lead: ${detail}${interest}`;
}

export interface RenderTranscriptOptions {
  /** Teto de caracteres do corpo do transcript (mantém as mais recentes). */
  maxChars: number;
}

export interface RenderedTranscript {
  text: string;
  /** message_ids completos efetivamente incluídos no transcript (não-ruído). */
  includedMessageIds: string[];
  /** Mapa <id8> → uuid completo, para remapear a evidência citada pelo modelo. */
  shortIdToFull: Record<string, string>;
}

/**
 * Monta o transcript renderizado + o cabeçalho de desfecho do lead.
 * `messages` deve vir em ordem cronológica ascendente.
 */
export function renderTranscript(
  messages: RenderableMessage[],
  lead: LeadSnapshot | null,
  opts: RenderTranscriptOptions,
): RenderedTranscript {
  const shortIdToFull: Record<string, string> = {};
  const rendered: Array<{ line: string; id: string }> = [];

  for (const m of messages) {
    const line = renderLine(m);
    if (line === null) continue;
    shortIdToFull[shortId(m.id)] = m.id;
    rendered.push({ line, id: m.id });
  }

  // Truncamento: mantém as MAIS RECENTES (corta do início).
  let kept = rendered;
  let truncated = false;
  let total = rendered.reduce((acc, r) => acc + r.line.length + 1, 0);
  if (total > opts.maxChars) {
    truncated = true;
    const out: Array<{ line: string; id: string }> = [];
    let running = 0;
    for (let i = rendered.length - 1; i >= 0; i--) {
      const len = rendered[i]!.line.length + 1;
      if (running + len > opts.maxChars) break;
      running += len;
      out.unshift(rendered[i]!);
    }
    kept = out;
    total = running;
  }

  const header = renderLeadHeader(lead);
  const bodyLines = kept.map((r) => r.line);
  const truncNote = truncated ? '[… início da conversa truncado …]\n' : '';
  const text = `${header}\n\nTRANSCRIÇÃO DA CONVERSA:\n${truncNote}${bodyLines.join('\n')}`;

  return {
    text,
    includedMessageIds: kept.map((r) => r.id),
    shortIdToFull,
  };
}
