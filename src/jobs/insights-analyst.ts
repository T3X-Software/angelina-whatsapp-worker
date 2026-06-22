// src/jobs/insights-analyst.ts
//
// Feature `conversation-insights`.
//
// Orquestrador do AGENTE ANALISTA DE CONVERSAS. Roda em dois modos:
//   - cron (digest periódico) via `startInsightsCron` (setInterval, espelha
//     `startFollowUpCron`).
//   - on-demand via `runInsightsAnalyst({ trigger:'on_demand', runId })`,
//     disparado pelo endpoint HTTP interno (src/edge/insights-trigger.ts).
//
// É um componente SEPARADO da HarnessLoop — read-only nas tabelas de origem,
// não envia mensagens, não chama hooks. Serializado por advisory lock
// (mesmo mecanismo do follow-up). Lê config viva de agent_configs
// (key 'insights_analyst', cache 30s) — zero hardcode.

import pino, { type Logger } from 'pino';
import { acquireLock, releaseLock } from '../utils/distributed-lock';
import { db } from '../db/client';
import { traces } from '../db/schema';
import { findActiveByKey } from '../config/agent-configs';
import { readInsightsConfig } from '../insights/config';
import { renderTranscript } from '../insights/transcript-renderer';
import { analyzeConversation } from '../insights/analyst-core';
import {
  createRun,
  finishRun,
  failRun,
  insertFindings,
  getLastRunCursor,
  selectCandidateContactIds,
  loadConversation,
  type InsightRunTrigger,
} from '../insights/repository';

export const INSIGHTS_ANALYST_LOCK_KEY = 'insights_analyst';
const AGENT_KEY = 'insights_analyst';

export interface InsightsRunOptions {
  trigger: InsightRunTrigger;
  /** Run pré-criada (caminho on-demand: a rota cria a run e devolve o id). */
  runId?: string;
  /** Restringe a análise a estes contatos (caminho on-demand / smoke). */
  contactIds?: string[];
  /** Sobrescreve o teto de conversas desta execução. */
  maxConversations?: number;
  logger?: Logger;
}

export interface InsightsRunSummary {
  runId: string | null;
  analyzed: number;
  failed: number;
  findingsCount: number;
  totalCostUsd: number;
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  skipReason?: string;
}

/** INSERT pontual em `traces` (fora-de-turno). Fail-silent. */
async function emitTrace(
  eventType: string,
  payload: Record<string, unknown> = {},
  opts: { severity?: 'info' | 'med' | 'high'; contactId?: string | null } = {},
): Promise<void> {
  try {
    await db.insert(traces).values({
      eventType,
      payload: { ...payload, severity: opts.severity ?? 'info' },
      contactId: opts.contactId ?? null,
      leadId: null,
    });
  } catch {
    // fail-silent — trace é observability, não correção.
  }
}

/**
 * Prepara uma run on-demand: lê config, e se o analista estiver disponível
 * (config presente + enabled), cria a row `insight_runs` em 'running' e
 * devolve o id. Retorna `null` quando indisponível (rota responde 503).
 */
export async function prepareOnDemandRun(): Promise<string | null> {
  const agentConfig = await findActiveByKey(AGENT_KEY);
  const config = readInsightsConfig(agentConfig);
  if (!agentConfig || !config.enabled) return null;
  return createRun('on_demand', agentConfig.model);
}

/**
 * Executa UMA run do analista (cron ou on-demand). Idempotente quanto ao lock:
 * se outra run estiver em curso, marca esta como 'skipped' e sai.
 */
export async function runInsightsAnalyst(
  opts: InsightsRunOptions,
): Promise<InsightsRunSummary> {
  const logger = opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });

  const agentConfig = await findActiveByKey(AGENT_KEY);
  const config = readInsightsConfig(agentConfig);

  const empty: InsightsRunSummary = {
    runId: opts.runId ?? null,
    analyzed: 0,
    failed: 0,
    findingsCount: 0,
    totalCostUsd: 0,
    status: 'skipped',
  };

  if (!agentConfig) {
    logger.warn({ event: 'insights_config_missing' }, 'agent_configs insights_analyst missing');
    await emitTrace('insights_config_missing', {}, { severity: 'high' });
    if (opts.runId) await failRun(opts.runId, { reason: 'no_config' });
    return { ...empty, skipReason: 'no_config' };
  }
  if (!config.enabled) {
    logger.info({ event: 'insights_disabled' }, 'insights analyst disabled');
    await emitTrace('insights_disabled', {});
    if (opts.runId) {
      await finishRun(opts.runId, {
        status: 'skipped',
        conversationsAnalyzed: 0,
        findingsCount: 0,
        totalCostUsd: 0,
      });
    }
    return { ...empty, skipReason: 'disabled' };
  }

  const acquired = await acquireLock(INSIGHTS_ANALYST_LOCK_KEY);
  if (!acquired) {
    logger.info({ event: 'insights_lock_skipped' }, 'another run holds the lock');
    await emitTrace('insights_lock_skipped', {});
    if (opts.runId) {
      await finishRun(opts.runId, {
        status: 'skipped',
        conversationsAnalyzed: 0,
        findingsCount: 0,
        totalCostUsd: 0,
      });
    }
    return { ...empty, skipReason: 'lock_held' };
  }

  const model = agentConfig.model;
  const temperature = Number(agentConfig.temperature ?? 0.2);
  const systemPrompt = agentConfig.systemPrompt;
  let runId = opts.runId ?? null;

  try {
    if (!runId) runId = await createRun(opts.trigger, model);
    await emitTrace('insights_run_start', { runId, trigger: opts.trigger });

    const cursor = opts.contactIds
      ? null
      : opts.trigger === 'cron'
        ? await getLastRunCursor()
        : null;

    const candidates =
      opts.contactIds ??
      (await selectCandidateContactIds({
        cursor,
        lookbackHours: config.lookbackHours,
        minMessages: config.minMessagesToAnalyze,
        limit: opts.maxConversations ?? config.maxConversationsPerRun,
      }));

    let analyzed = 0;
    let failed = 0;
    let findingsCount = 0;
    let totalCostUsd = 0;
    let budgetHit = false;

    for (const contactId of candidates) {
      try {
        const conv = await loadConversation(contactId);
        if (conv.messages.length < config.minMessagesToAnalyze) continue;

        const rendered = renderTranscript(conv.messages, conv.lead, {
          maxChars: config.transcriptMaxChars,
        });
        if (rendered.includedMessageIds.length < config.minMessagesToAnalyze) {
          continue; // sobrou pouca coisa depois de filtrar ruído
        }

        const result = await analyzeConversation({
          systemPrompt,
          model,
          temperature,
          rendered,
          maxFindings: config.maxFindingsPerConversation,
        });

        // Contabiliza o custo ANTES do persist: o LLM já foi cobrado, então o
        // budget guard deve enxergá-lo mesmo que o INSERT falhe.
        totalCostUsd += result.costUsd;

        await insertFindings(
          runId,
          contactId,
          conv.lead?.id ?? null,
          result.verdict,
          result.findings,
        );

        analyzed += 1;
        findingsCount += result.findings.length;
        await emitTrace(
          'insights_conversation_analyzed',
          { findings: result.findings.length, cost_usd: result.costUsd, verdict: result.verdict },
          { contactId },
        );

        if (totalCostUsd >= config.maxCostUsdPerRun) {
          budgetHit = true;
          await emitTrace('insights_budget_reached', { total_cost_usd: totalCostUsd }, { severity: 'med' });
          break;
        }
      } catch (convErr) {
        failed += 1;
        const err = convErr instanceof Error ? convErr.message : String(convErr);
        logger.error({ event: 'insights_conversation_failed', contactId, err }, 'conversation analysis failed');
        await emitTrace('insights_conversation_failed', { err }, { severity: 'med', contactId });
      }
    }

    const status: InsightsRunSummary['status'] =
      analyzed === 0 && failed > 0 ? 'failed' : budgetHit ? 'partial' : 'completed';

    await finishRun(runId, {
      status,
      conversationsAnalyzed: analyzed,
      findingsCount,
      totalCostUsd,
      error: failed > 0 ? { failed } : null,
    });
    await emitTrace('insights_run_complete', {
      runId,
      analyzed,
      failed,
      findings_count: findingsCount,
      total_cost_usd: totalCostUsd,
      status,
    });

    logger.info(
      { event: 'insights_run_complete', runId, analyzed, failed, findingsCount, totalCostUsd, status },
      'insights run complete',
    );

    return { runId, analyzed, failed, findingsCount, totalCostUsd, status };
  } catch (outer) {
    const err = outer instanceof Error ? outer.message : String(outer);
    logger.error({ event: 'insights_run_failed', runId, err }, 'insights run failed');
    if (runId) await failRun(runId, { err });
    await emitTrace('insights_run_failed', { err }, { severity: 'high' });
    return { ...empty, runId, status: 'failed', skipReason: 'error' };
  } finally {
    await releaseLock(INSIGHTS_ANALYST_LOCK_KEY);
  }
}

export interface InsightsCronDeps {
  logger?: Logger;
}

/**
 * Agenda o cron do analista via setInterval. Retorna o handle p/ clearInterval
 * no shutdown. Lê `cron_interval_ms` 1× no boot (igual startFollowUpCron).
 */
export async function startInsightsCron(
  deps: InsightsCronDeps = {},
): Promise<NodeJS.Timeout> {
  const logger = deps.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const agentConfig = await findActiveByKey(AGENT_KEY);
  const config = readInsightsConfig(agentConfig);
  const intervalMs = config.cronIntervalMs;

  logger.info(
    { event: 'insights_cron_starting', interval_ms: intervalMs, enabled: config.enabled },
    'insights analyst cron scheduled',
  );

  const handle = setInterval(() => {
    runInsightsAnalyst({ trigger: 'cron', logger }).catch((err) => {
      logger.error(
        { event: 'insights_cron_uncaught', err: err?.message ?? String(err) },
        'runInsightsAnalyst threw — interval continues',
      );
    });
  }, intervalMs);

  return handle;
}
