// src/tools/registry.ts
//
// Bloco 7 — Task 39.
//
// Registry das 4 tools reais da Angelina (Bloco 7). Exporta:
//   - ALL_TOOLS — array imutável com as 4 tools (save_lead_info,
//     classify_lead, transfer_to_human, remember_fact).
//   - getToolByName(name) — lookup case-sensitive exato.
//   - getEnabledTools(toolsEnabled[]) — filtra ALL_TOOLS pelo array
//     `agent_configs.tools_enabled`. Loga warn (via console — pino é
//     responsabilidade do loop) se algum nome em toolsEnabled NÃO casar
//     com nenhuma tool conhecida (typo na config).
//
// Invariantes (ver CLAUDE.md raiz):
//   - INVARIANTE 3: tools NÃO chamam LLM (nenhum import de @anthropic-ai/sdk
//     ou similar nesta pasta).
//   - INVARIANTE 4: tools NÃO enviam mensagem (nenhum import de ZapsterClient
//     em src/tools/*).
//
// Tipo `Tool` está alinhado com `src/harness/types.ts` — input Zod, execute
// retornando `ToolResult<T>`.

import type { AnyTool } from '../harness/types';

import { saveLeadInfoTool } from './save-lead-info';
import { classifyLeadTool } from './classify-lead';
import { transferToHumanTool } from './transfer-to-human';
import { rememberFactTool } from './remember-fact';
import { checkBlockedDatesTool } from './check-blocked-dates';
import { selectMediaTool } from './select-media';

/**
 * Lista canônica de TODAS as tools conhecidas pelo worker.
 *
 * Ordem do array é informativa (alguns logs preservam essa ordem) mas
 * NÃO afeta semântica — o LLM escolhe pelo `name`.
 *
 * Para adicionar uma tool nova:
 *   1. Criar `src/tools/<nome>.ts` exportando `<Nome>Tool: Tool`.
 *   2. Adicionar ao array abaixo.
 *   3. Atualizar `agent_configs.tools_enabled` na migration que ativa.
 */
export const ALL_TOOLS: ReadonlyArray<AnyTool> = [
  saveLeadInfoTool,
  classifyLeadTool,
  transferToHumanTool,
  rememberFactTool,
  checkBlockedDatesTool, // Feature 1.11 — read-only
  selectMediaTool, // Feature 1.9 — read-only (envio é via hook media-sender, Commit 2)
] as const;

/**
 * Lookup por nome (case-sensitive, exato). Retorna `undefined` se não achou.
 *
 * Use no loop de tool dispatch após o LLM retornar `tool_use` blocks: cada
 * block tem `name` que precisa bater EXATO com `Tool.name`.
 */
export function getToolByName(name: string): AnyTool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/**
 * Filtra ALL_TOOLS pelos nomes habilitados em `agent_configs.tools_enabled`.
 *
 * Comportamento:
 *   - Retorna apenas as tools cujo `name` aparece em `toolsEnabled`.
 *   - Se algum nome em `toolsEnabled` NÃO bater com nenhuma tool conhecida,
 *     loga warn (typo na config). Não throwa — segue com o subset válido.
 *   - Preserva a ordem de `ALL_TOOLS`, não a ordem de `toolsEnabled`.
 *
 * Decisão (Bloco 7): logamos via `console.warn` em vez de receber um logger
 * injetado. Em prod, o `loop.ts` chama isso com pino disponível, mas a
 * frequência é baixa (1×/turno) e o subset de toolsEnabled vem direto da
 * config do banco (não do LLM), então o warn é raro e indica drift entre
 * migration de `agent_configs` e o registry de código.
 */
export function getEnabledTools(toolsEnabled: ReadonlyArray<string>): AnyTool[] {
  const knownNames = new Set(ALL_TOOLS.map((t) => t.name));
  const unknownNames: string[] = [];

  for (const name of toolsEnabled) {
    if (!knownNames.has(name)) {
      unknownNames.push(name);
    }
  }

  if (unknownNames.length > 0) {
    console.warn(
      '[tools/registry] toolsEnabled contains unknown tool names (typo in agent_configs.tools_enabled?):',
      unknownNames,
      '— knownNames:',
      Array.from(knownNames),
    );
  }

  return ALL_TOOLS.filter((t) => toolsEnabled.includes(t.name));
}
