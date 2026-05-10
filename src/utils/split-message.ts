// src/utils/split-message.ts
//
// Bloco 2 — Task 8 da feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Splitter de mensagens longas em até `max_parts` partes naturais.
//
// Estratégia (decisão 1.1 do plan + Bloco 1):
//   1. Split por `\n\n` (parágrafos).
//   2. Coalesce parágrafos consecutivos enquanto soma <= soft_limit (parts
//      pequenas costuradas em uma só, evitando spam de mensagens curtas).
//   3. Se uma parte resultante ainda > hard_limit, sub-divide por sentence
//      (regex `/(?<=[.!?])\s+/`) tentando manter cada fatia <= hard_limit.
//   4. Sentences sozinhas > hard_limit são emitidas como estão (não trunca —
//      UX > limite estrito; Zapster aceita até 4096 chars/mensagem).
//   5. Se o array final excede `max_parts`, concatenar partes excedentes
//      (`max_parts..end`) com `\n\n` na última parte permitida (decisão T2.4).
//   6. Trim final em cada parte; descartar partes vazias.
//
// Sub-decisão T2.4 (aprovada Bloco 2): partes excedentes (5+ quando max=4)
// são CONCATENADAS na última parte permitida. Cliente vê tudo, em ≤max_parts
// mensagens. Truncar (descartar) é pior UX; deixar sem dividir é pior pelo
// efeito "muralha" original.
//
// Casos especiais (entrada):
//   - text vazio ('' ou só whitespace) → retorna `[]` (não envia mensagem
//     vazia — invariante implícita: o sender só é chamado com texto útil).
//   - text com 1 parágrafo curto (<= soft_limit) → retorna `[text.trim()]`.
//
// Função pura — sem I/O, sem LLM (invariante #3), sem envio (invariante #4).

import type { MessageSplitConfig } from '../config/types';

/**
 * Default v3 (migration 20260509000000_handoff_continuity).
 *
 * Aplicado quando o caller chama `splitMessage` sem fornecer config completa
 * — defensivo, mas o pattern recomendado é sempre puxar de
 * `agent_configs.hook_params.message_split` no chamador.
 */
export const DEFAULT_MESSAGE_SPLIT_CONFIG: MessageSplitConfig = {
  soft_limit: 800,
  hard_limit: 1200,
  max_parts: 4,
  interval_ms: 1500,
};

/**
 * Sub-divide uma parte > hard_limit em sentences (`. ` `! ` `? ` + whitespace).
 * Coalesce sentences consecutivas mantendo cada fatia <= hard_limit.
 *
 * Sentences únicas que extrapolam hard_limit são emitidas como estão (sem
 * trunca — passamos o "muro de texto" inalterado pra essa parte; preferível
 * a cortar no meio).
 */
function splitByHardLimit(text: string, hardLimit: number): string[] {
  if (text.length <= hardLimit) return [text];

  // Split mantendo o terminator: `(?<=[.!?])\s+` — preserva pontuação na
  // sentence anterior, separa apenas no whitespace pós-pontuação.
  const sentences = text.split(/(?<=[.!?])\s+/);

  const out: string[] = [];
  let buf = '';

  for (const s of sentences) {
    const candidate = buf ? `${buf} ${s}` : s;
    if (candidate.length <= hardLimit) {
      buf = candidate;
      continue;
    }
    // Caber não cabe — flush buf, começa novo com `s`.
    if (buf) out.push(buf);
    if (s.length <= hardLimit) {
      buf = s;
    } else {
      // Sentence única excede hardLimit — emit como está (sem trunca).
      out.push(s);
      buf = '';
    }
  }

  if (buf) out.push(buf);
  return out;
}

/**
 * Coalesce parágrafos consecutivos enquanto a soma <= soft_limit. Reduz
 * fragmentação quando a IA emite vários parágrafos curtos.
 */
function coalesceParagraphs(paragraphs: string[], softLimit: number): string[] {
  const out: string[] = [];
  let buf = '';

  for (const p of paragraphs) {
    if (!p) continue;
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length <= softLimit) {
      buf = candidate;
      continue;
    }
    if (buf) out.push(buf);
    buf = p;
  }

  if (buf) out.push(buf);
  return out;
}

/**
 * Divide uma mensagem em até `config.max_parts` partes naturais.
 *
 * Algoritmo determinístico (sem regex stateful nem LLM).
 *
 * @returns array de strings (1+ ou 0 se o input for vazio/whitespace).
 *          Cada parte é trimada. Comprimento <= max_parts (concatena resto
 *          na última se necessário).
 */
export function splitMessage(
  text: string,
  config: MessageSplitConfig = DEFAULT_MESSAGE_SPLIT_CONFIG,
): string[] {
  // Defensivo — força valores sãos (evita ÷0 ou max_parts=0).
  const softLimit = Math.max(1, config.soft_limit);
  const hardLimit = Math.max(softLimit, config.hard_limit);
  const maxParts = Math.max(1, config.max_parts);

  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // [1] Split por `\n\n` (parágrafos).
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return [];

  // [2] Coalesce parágrafos pequenos enquanto soma <= soft_limit.
  const coalesced = coalesceParagraphs(paragraphs, softLimit);

  // [3] Sub-divide partes > hard_limit por sentence.
  const expanded: string[] = [];
  for (const part of coalesced) {
    const subs = splitByHardLimit(part, hardLimit);
    for (const s of subs) {
      const t = s.trim();
      if (t) expanded.push(t);
    }
  }

  if (expanded.length === 0) return [];

  // [4] Limita a max_parts — concatena resto com `\n\n` na última permitida.
  if (expanded.length <= maxParts) return expanded;

  const head = expanded.slice(0, maxParts - 1);
  const tail = expanded.slice(maxParts - 1).join('\n\n');
  return [...head, tail];
}
