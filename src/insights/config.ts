// src/insights/config.ts
//
// Feature `conversation-insights`.
//
// Tipo + parser dos parâmetros operacionais do analista, lidos de
// `agent_configs.hook_params.insights_analyst` (key 'insights_analyst',
// hot-reload via findActiveByKey/cache 30s). Defaults conservadores aplicados
// quando o sub-objeto está ausente ou parcial — mesma filosofia do follow-up.

import type { AgentConfigRow } from '../harness/types';

export interface InsightsAnalystConfig {
  enabled: boolean;
  cronIntervalMs: number;
  maxConversationsPerRun: number;
  lookbackHours: number;
  maxFindingsPerConversation: number;
  transcriptMaxChars: number;
  minMessagesToAnalyze: number;
  maxCostUsdPerRun: number;
}

export const DEFAULT_INSIGHTS_CONFIG: InsightsAnalystConfig = {
  enabled: true,
  cronIntervalMs: 86_400_000, // 24h
  maxConversationsPerRun: 20,
  lookbackHours: 168, // 7 dias
  maxFindingsPerConversation: 8,
  transcriptMaxChars: 12_000,
  minMessagesToAnalyze: 4,
  maxCostUsdPerRun: 2.0,
};

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Extrai a config do analista da row de `agent_configs` (key 'insights_analyst').
 * Aplica defaults campo a campo — nunca lança.
 */
export function readInsightsConfig(
  row: AgentConfigRow | null,
): InsightsAnalystConfig {
  const d = DEFAULT_INSIGHTS_CONFIG;
  const raw =
    (row?.hookParams as { insights_analyst?: Record<string, unknown> } | null)
      ?.insights_analyst ?? {};

  return {
    enabled: bool(raw['enabled'], d.enabled),
    cronIntervalMs: num(raw['cron_interval_ms'], d.cronIntervalMs),
    maxConversationsPerRun: num(
      raw['max_conversations_per_run'],
      d.maxConversationsPerRun,
    ),
    lookbackHours: num(raw['lookback_hours'], d.lookbackHours),
    maxFindingsPerConversation: num(
      raw['max_findings_per_conversation'],
      d.maxFindingsPerConversation,
    ),
    transcriptMaxChars: num(raw['transcript_max_chars'], d.transcriptMaxChars),
    minMessagesToAnalyze: num(
      raw['min_messages_to_analyze'],
      d.minMessagesToAnalyze,
    ),
    maxCostUsdPerRun: num(raw['max_cost_usd_per_run'], d.maxCostUsdPerRun),
  };
}
