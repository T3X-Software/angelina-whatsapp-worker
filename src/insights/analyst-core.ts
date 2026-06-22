// src/insights/analyst-core.ts
//
// Feature `conversation-insights`.
//
// Núcleo por-conversa, puro e testável. Recebe o transcript renderizado + o
// system prompt (de agent_configs) e chama `callClaude` FORÇANDO a tool
// `report_insights` (tool_choice). Lê `response.toolCalls[0].input`, valida com
// Zod, remapeia a evidência (id8 → uuid completo) e descarta findings cuja
// evidência não pertence ao transcript (anti-alucinação). Calcula o custo.
//
// NÃO toca no banco e NÃO faz IO além do callClaude — quem persiste é o
// repository, chamado pelo job.

import { callClaude } from '../llm/anthropic';
import { calculateCost } from '../llm/pricing';
import type { LLMMessage, LLMUsage } from '../llm/types';
import {
  REPORT_INSIGHTS_TOOL_NAME,
  reportInsightsSchema,
  reportInsightsTool,
  type InsightFinding,
} from './report-insights-tool';
import type { RenderedTranscript } from './transcript-renderer';

export interface AnalyzedFinding {
  category: InsightFinding['category'];
  severity: InsightFinding['severity'];
  summary: string;
  suggestion: string;
  /** message_ids completos (uuid) já remapeados e validados. */
  evidenceMessageIds: string[];
}

export interface AnalyzeConversationResult {
  findings: AnalyzedFinding[];
  verdict: 'good' | 'recoverable' | 'lost_opportunity';
  usage: LLMUsage;
  costUsd: number;
  model: string;
}

export class AnalysisFailedError extends Error {
  override readonly name = 'AnalysisFailedError';
}

export interface AnalyzeConversationArgs {
  systemPrompt: string;
  model: string;
  temperature: number;
  rendered: RenderedTranscript;
  maxFindings: number;
  maxTokens?: number;
}

/**
 * Remapeia os ids citados pelo modelo (geralmente o prefixo de 8 chars exibido
 * no transcript) para o uuid completo, descartando os que não pertencem à
 * conversa enviada.
 */
function resolveEvidenceIds(
  citedIds: string[],
  rendered: RenderedTranscript,
): string[] {
  const fullSet = new Set(Object.values(rendered.shortIdToFull));
  const out = new Set<string>();
  for (const cited of citedIds) {
    if (fullSet.has(cited)) {
      out.add(cited); // já é uuid completo válido
      continue;
    }
    const mapped = rendered.shortIdToFull[cited.slice(0, 8)];
    if (mapped) out.add(mapped);
  }
  return [...out];
}

export async function analyzeConversation(
  args: AnalyzeConversationArgs,
): Promise<AnalyzeConversationResult> {
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content:
        `Analise a conversa abaixo e reporte os pontos de melhoria via a ` +
        `ferramenta ${REPORT_INSIGHTS_TOOL_NAME}. Cite em evidence.messageIds ` +
        `os identificadores [entre colchetes] das mensagens relevantes.\n\n` +
        args.rendered.text,
    },
  ];

  // Até 2 tentativas: o modelo PODE ignorar a tool mesmo com tool_choice forçado
  // em casos raros (refusal). 1 retry antes de desistir.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await callClaude({
      systemPrompt: args.systemPrompt,
      messages,
      tools: [reportInsightsTool],
      toolChoice: { type: 'tool', name: REPORT_INSIGHTS_TOOL_NAME },
      model: args.model,
      temperature: args.temperature,
      maxTokens: args.maxTokens ?? 2048,
    });

    const call = resp.toolCalls.find((t) => t.name === REPORT_INSIGHTS_TOOL_NAME);
    if (!call) {
      lastErr = new AnalysisFailedError('model did not call report_insights');
      continue;
    }

    const parsed = reportInsightsSchema.safeParse(call.input);
    if (!parsed.success) {
      lastErr = new AnalysisFailedError(
        `invalid report_insights payload: ${parsed.error.message}`,
      );
      continue;
    }

    const costUsd = calculateCost(
      resp.model,
      resp.usage.inputTokens,
      resp.usage.outputTokens,
      resp.usage.cacheReadInputTokens ?? 0,
      resp.usage.cacheCreationInputTokens ?? 0,
    );

    const raw = parsed.data;
    const findings: AnalyzedFinding[] = raw.noFindings
      ? []
      : raw.findings
          .map((f) => ({
            category: f.category,
            severity: f.severity,
            summary: f.summary,
            suggestion: f.suggestion,
            evidenceMessageIds: resolveEvidenceIds(
              f.evidence.messageIds,
              args.rendered,
            ),
          }))
          // anti-alucinação: descarta finding sem nenhuma evidência válida.
          .filter((f) => f.evidenceMessageIds.length > 0)
          .slice(0, args.maxFindings);

    return {
      findings,
      verdict: raw.conversationVerdict,
      usage: resp.usage,
      costUsd,
      model: resp.model,
    };
  }

  throw lastErr instanceof Error
    ? lastErr
    : new AnalysisFailedError('analysis failed');
}
