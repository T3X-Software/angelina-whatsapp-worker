// src/utils/prompt-blocks.ts
//
// Feature B (itens 1.2 / 1.3) — montagem do system prompt a partir de blocos
// nomeados (`hook_params.prompt`). Função PURA (sem IO): concatena os blocos
// preenchidos na ORDEM FIXA abaixo, separados por linha em branco.
//
// Isolada do composer de propósito (composer importa harness/db) — assim a
// lógica de montagem é testável por um smoke simples.

import type { PromptBlocksConfig } from '../config/types';

/**
 * Ordem canônica de concatenação dos blocos. NÃO reordenar sem alinhar com a
 * plataforma (é o contrato do editor de prompt).
 */
export const PROMPT_BLOCK_ORDER: ReadonlyArray<keyof PromptBlocksConfig> = [
  'identidade',
  'saudacao',
  'tom_de_voz',
  'objetivo',
  'regras_duras',
  'base_estabelecimento',
];

/**
 * Monta o system prompt a partir dos blocos preenchidos, na ordem fixa.
 *
 * - Ignora blocos ausentes, não-string ou só com espaços.
 * - Junta os presentes com `\n\n`.
 * - Retorna `''` quando nenhum bloco qualifica — o caller decide o fallback
 *   (no composer: cair para `system_prompt`).
 *
 * Defensivo: aceita `unknown`/objeto malformado (a config vem de JSONB).
 */
export function assembleSystemBlocks(
  prompt: PromptBlocksConfig | null | undefined,
): string {
  if (!prompt || typeof prompt !== 'object') return '';

  const parts: string[] = [];
  for (const key of PROMPT_BLOCK_ORDER) {
    const val = (prompt as Record<string, unknown>)[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      parts.push(val.trim());
    }
  }
  return parts.join('\n\n');
}
