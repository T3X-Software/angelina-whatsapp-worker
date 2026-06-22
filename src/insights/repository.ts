// src/insights/repository.ts
//
// Feature `conversation-insights`.
//
// Toda a persistência do analista via `db.execute(sql\`...\`)` (SQL cru
// parametrizado) — mesmo padrão de `src/tools/classify-lead.ts`. Centraliza o
// SQL aqui para não depender de `schema.ts` conhecer as tabelas novas
// (`insight_runs`/`conversation_insights` nascem por migration Supabase; o
// `db:pull` do worker é opcional para esta feature).
//
// Read-only nas tabelas de origem (messages/leads); escreve só nas tabelas de
// insight — consistente com o worker já escrever traces/timeline_events.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { AnalyzedFinding } from './analyst-core';

export type InsightRunTrigger = 'cron' | 'on_demand';
export type InsightRunStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped';

function firstRow<T>(rows: unknown): T | undefined {
  return (Array.from(rows as Iterable<T>) as T[])[0];
}

/** Cria uma run em status 'running'. Retorna o id. */
export async function createRun(
  trigger: InsightRunTrigger,
  model: string,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO insight_runs (trigger, status, model)
    VALUES (${trigger}::insight_run_trigger, 'running'::insight_run_status, ${model})
    RETURNING id
  `);
  const row = firstRow<{ id: string }>(rows);
  if (!row) throw new Error('createRun: no id returned');
  return row.id;
}

export interface FinishRunInput {
  status: InsightRunStatus;
  conversationsAnalyzed: number;
  findingsCount: number;
  totalCostUsd: number;
  error?: Record<string, unknown> | null;
}

/** Finaliza a run com status + contadores. */
export async function finishRun(
  runId: string,
  input: FinishRunInput,
): Promise<void> {
  await db.execute(sql`
    UPDATE insight_runs
       SET status = ${input.status}::insight_run_status,
           conversations_analyzed = ${input.conversationsAnalyzed},
           findings_count = ${input.findingsCount},
           total_cost_usd = ${input.totalCostUsd},
           error = ${input.error ? JSON.stringify(input.error) : null}::jsonb
     WHERE id = ${runId}
  `);
}

/** Marca a run como falha (caminho de erro fatal). */
export async function failRun(
  runId: string,
  error: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    UPDATE insight_runs
       SET status = 'failed'::insight_run_status,
           error = ${JSON.stringify(error)}::jsonb
     WHERE id = ${runId}
  `);
}

/** Insere os findings de UMA conversa. Um INSERT por finding (baixo volume). */
export async function insertFindings(
  runId: string,
  contactId: string,
  leadId: string | null,
  verdict: 'good' | 'recoverable' | 'lost_opportunity',
  findings: AnalyzedFinding[],
): Promise<void> {
  for (const f of findings) {
    // Drizzle expande array JS como lista separada por vírgula ($1, $2) — útil
    // para IN(...), mas inválido para uuid[]. Construímos ARRAY[...]::uuid[]
    // explicitamente via sql.join (cada elemento vira um placeholder).
    const evidenceExpr =
      f.evidenceMessageIds.length > 0
        ? sql`ARRAY[${sql.join(
            f.evidenceMessageIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[]`
        : sql`'{}'::uuid[]`;

    await db.execute(sql`
      INSERT INTO conversation_insights (
        run_id, contact_id, lead_id, category, severity,
        summary, suggestion, evidence_message_ids, verdict
      ) VALUES (
        ${runId},
        ${contactId},
        ${leadId},
        ${f.category}::insight_category,
        ${f.severity}::insight_severity,
        ${f.summary},
        ${f.suggestion},
        ${evidenceExpr},
        ${verdict}::conversation_verdict
      )
    `);
  }
}

/** Cursor da última run concluída (completed/partial). Null se nenhuma. */
export async function getLastRunCursor(): Promise<Date | null> {
  const rows = await db.execute<{ cursor: Date | null }>(sql`
    SELECT max(created_at) AS cursor
      FROM insight_runs
     WHERE status IN ('completed','partial')
  `);
  return firstRow<{ cursor: Date | null }>(rows)?.cursor ?? null;
}

export interface SelectCandidatesInput {
  cursor: Date | null;
  lookbackHours: number;
  minMessages: number;
  limit: number;
}

/**
 * Seleciona contact_ids candidatos: conversas com >= minMessages e atividade
 * recente (dentro de lookbackHours e, se cursor, após ele). Ordena pelas mais
 * recentes. Read-only sobre `messages`.
 */
export async function selectCandidateContactIds(
  input: SelectCandidatesInput,
): Promise<string[]> {
  const cursorClause = input.cursor
    ? sql`AND max(m.created_at) > ${input.cursor}`
    : sql``;
  const rows = await db.execute<{ contact_id: string }>(sql`
    SELECT m.contact_id
      FROM messages m
     GROUP BY m.contact_id
    HAVING count(*) >= ${input.minMessages}
       AND max(m.created_at) >= now() - make_interval(hours => ${input.lookbackHours}::int)
       ${cursorClause}
     ORDER BY max(m.created_at) DESC
     LIMIT ${input.limit}
  `);
  return (Array.from(rows) as Array<{ contact_id: string }>).map(
    (r) => r.contact_id,
  );
}

export interface ConversationData {
  messages: Array<{
    id: string;
    direction: string;
    role: string;
    text: string | null;
    mediaType: string | null;
    transcription: string | null;
    toolName: string | null;
    toolArgs: unknown;
    toolResult: unknown;
    redactedAt: Date | string | null;
    createdAt: Date | string | null;
  }>;
  lead: {
    id: string;
    classification: string | null;
    eventType: string | null;
    eventDate: string | null;
    guestCount: number | null;
    status: string | null;
    isHumanActive: boolean | null;
    handoffAssumedAt: Date | string | null;
    interestSummary: string | null;
  } | null;
}

/** Carrega mensagens (cronológico) + o lead mais recente do contato. */
export async function loadConversation(
  contactId: string,
): Promise<ConversationData> {
  const msgRows = await db.execute(sql`
    SELECT id, direction::text AS direction, role::text AS role, text,
           media_type AS "mediaType", transcription,
           tool_name AS "toolName", tool_args AS "toolArgs",
           tool_result AS "toolResult", redacted_at AS "redactedAt",
           created_at AS "createdAt"
      FROM messages
     WHERE contact_id = ${contactId}
     ORDER BY created_at ASC
  `);

  const leadRows = await db.execute(sql`
    SELECT id, classification::text AS classification,
           event_type::text AS "eventType", event_date::text AS "eventDate",
           guest_count AS "guestCount", status::text AS status,
           is_human_active AS "isHumanActive",
           handoff_assumed_at AS "handoffAssumedAt",
           interest_summary AS "interestSummary"
      FROM leads
     WHERE contact_id = ${contactId}
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
  `);

  return {
    messages: Array.from(msgRows) as ConversationData['messages'],
    lead: (firstRow(leadRows) as ConversationData['lead']) ?? null,
  };
}

/**
 * Sweep de runs órfãs 'running' mais antigas que `olderThanMinutes' — marca
 * como 'failed'. Chamado no boot (worker pode ter reiniciado no meio de uma run).
 */
export async function sweepStaleRuns(olderThanMinutes: number): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE insight_runs
       SET status = 'failed'::insight_run_status,
           error = '{"reason":"stale_running_swept_on_boot"}'::jsonb
     WHERE status = 'running'::insight_run_status
       AND created_at < now() - make_interval(mins => ${olderThanMinutes}::int)
    RETURNING id
  `);
  return (Array.from(rows) as Array<{ id: string }>).length;
}
