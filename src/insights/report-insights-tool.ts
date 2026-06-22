// src/insights/report-insights-tool.ts
//
// Feature `conversation-insights`.
//
// Define a "tool virtual" `report_insights` usada APENAS para forçar a saída
// estruturada do agente analista. Ela NÃO é dispatchada (não vai para o tool
// registry da harness, não roda no loop). O `analyst-core` força o modelo a
// chamá-la via `tool_choice` e lê `response.toolCalls[0].input` diretamente,
// validando com o `reportInsightsSchema` abaixo.
//
// `execute` é um no-op só para satisfazer a interface `Tool<I,O>` exigida por
// `callClaude` (que mapeia `tool.inputSchema` → JSON Schema via z.toJSONSchema).
// Não viola a invariante "tools não chamam LLM": esta tool nunca executa nada.

import { z } from 'zod';

import type { Tool } from '../harness/types';

export const INSIGHT_CATEGORIES = [
  'PROMPT',
  'KNOWLEDGE_GAP',
  'FUNNEL',
  'GUARDRAIL',
  'TONE',
] as const;

export const INSIGHT_SEVERITIES = ['low', 'med', 'high'] as const;

export const CONVERSATION_VERDICTS = [
  'good',
  'recoverable',
  'lost_opportunity',
] as const;

const evidenceSchema = z
  .object({
    contactId: z.string(),
    messageIds: z.array(z.string()).max(50),
  })
  .strict();

const findingSchema = z
  .object({
    category: z.enum(INSIGHT_CATEGORIES),
    severity: z.enum(INSIGHT_SEVERITIES),
    summary: z.string().max(280),
    suggestion: z.string().max(500),
    evidence: evidenceSchema,
  })
  .strict();

export const reportInsightsSchema = z
  .object({
    findings: z.array(findingSchema).max(20),
    conversationVerdict: z.enum(CONVERSATION_VERDICTS),
    noFindings: z.boolean(),
  })
  .strict();

export type ReportInsightsInput = z.infer<typeof reportInsightsSchema>;
export type InsightFinding = z.infer<typeof findingSchema>;

export const REPORT_INSIGHTS_TOOL_NAME = 'report_insights';

/**
 * Tool virtual — só existe para gerar o JSON Schema da saída estruturada.
 * Nunca é dispatchada; `execute` é no-op.
 */
export const reportInsightsTool: Tool<ReportInsightsInput, { ok: true }> = {
  name: REPORT_INSIGHTS_TOOL_NAME,
  description:
    'Reporta os pontos de melhoria (findings) extraídos da análise de UMA ' +
    'conversa. Chame exatamente uma vez. Use noFindings=true e findings=[] ' +
    'quando a conversa foi bem conduzida e não há pontos a levantar.',
  inputSchema: reportInsightsSchema,
  // eslint-disable-next-line @typescript-eslint/require-await
  execute: async () => ({ success: true, data: { ok: true } }),
};
