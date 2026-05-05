// src/hooks/format-whatsapp.ts
//
// Bloco 6 — Task 35. SEGUNDO hook de AFTER_MODEL (depois de transfer-trigger).
//
// Função pura de transformação de string sobre `ctx.lastModelText`. Não faz
// I/O. Converte Markdown comum (que LLMs adoram emitir) para a sintaxe
// nativa de formatação do WhatsApp.
//
// Conversões alvo:
//   1. **bold**     → *bold*
//   2. *italic*     → _italic_   (apenas pares isolados — não bold)
//   3. # / ## / ### → texto puro (remove o prefixo do header)
//   4. - item / * item → • item  (listas)
//   5. _ em URLs    → preservado (URL fica intocada)
//
// Não chama LLM (invariante 3). Não envia (invariante 4). Sempre retorna `{}`
// (não short-circuita) — apenas substitui `ctx.lastModelText`.
//
// Se transfer-trigger short-circuitou (handoff HOT), este hook NÃO roda — o
// `runPhase` do `loop.ts` aborta a fase no primeiro `shortCircuit:true`. Isso
// é correto: não há resposta da IA a formatar quando o pipeline foi cortado.
//
// Estratégia de implementação (ordem importa muito):
//   1. Extrai URLs como placeholders `Un`.
//   2. Extrai listas `^[-*]\s+` como placeholder `L` antes do
//      processamento de bold/italic (o `*` de lista poderia ser confundido).
//   3. Remove headers `^#{1,6}\s+`.
//   4. Bold `**texto**` → placeholder `Bn` (isola do italic;
//      depois de bold, não sobra mais `**` no texto).
//   5. Italic `*texto*` → `_texto_` (qualquer `*X*` remanescente).
//   6. Restaura placeholders: bold vira `*texto*`, lista vira `• `, URLs
//      voltam ao original.

import type { Hook, HookResult, HarnessContext } from '../harness/types';

// Sentinelas — chars de controle que nunca aparecem em texto WhatsApp normal.
const SENT_OPEN = '';
const SENT_CLOSE = '';
const URL_TAG = 'U';
const BOLD_TAG = 'B';
const LIST_TAG = 'L';

/**
 * Transforma um texto Markdown em sintaxe WhatsApp. Pura — sem efeitos
 * colaterais. Exportada para uso direto em testes.
 */
export function formatWhatsappText(input: string): string {
  if (!input) return input;

  // Etapa 1 — protege URLs.
  const urlRegex = /https?:\/\/\S+/g;
  const urls: string[] = [];
  let work = input.replace(urlRegex, (match) => {
    const idx = urls.length;
    urls.push(match);
    return `${SENT_OPEN}${URL_TAG}${idx}${SENT_CLOSE}`;
  });

  // Etapa 2 — listas `^[-*]\s+` viram placeholder antes que `*` confunda bold.
  work = work.replace(/^[\-*]\s+/gm, `${SENT_OPEN}${LIST_TAG}${SENT_CLOSE}`);

  // Etapa 3 — headers.
  work = work.replace(/^#{1,6}\s+/gm, '');

  // Etapa 4 — bold `**texto**` vira placeholder para isolar do italic.
  const bolds: string[] = [];
  work = work.replace(/\*\*([^*]+?)\*\*/g, (_match, inner: string) => {
    const idx = bolds.length;
    bolds.push(inner);
    return `${SENT_OPEN}${BOLD_TAG}${idx}${SENT_CLOSE}`;
  });

  // Etapa 5 — italic `*texto*` → `_texto_`. Apenas pares com texto não vazio,
  // sem `*` no meio, sem espaço encostado nos delimitadores.
  work = work.replace(
    /\*([^*\s][^*]*?[^*\s]|[^*\s])\*/g,
    (_match, inner: string) => `_${inner}_`,
  );

  // Etapa 6 — restaura placeholders.
  // Lista: `L` → `• `.
  const listRegex = new RegExp(`${SENT_OPEN}${LIST_TAG}${SENT_CLOSE}`, 'g');
  work = work.replace(listRegex, '• ');
  // Bold: `Bn` → `*texto*`.
  const boldRegex = new RegExp(
    `${SENT_OPEN}${BOLD_TAG}(\\d+)${SENT_CLOSE}`,
    'g',
  );
  work = work.replace(boldRegex, (_m, idx: string) => {
    return `*${bolds[Number(idx)] ?? ''}*`;
  });
  // URLs: `Un` → URL original.
  const urlPlaceholderRegex = new RegExp(
    `${SENT_OPEN}${URL_TAG}(\\d+)${SENT_CLOSE}`,
    'g',
  );
  work = work.replace(urlPlaceholderRegex, (_m, idx: string) => {
    return urls[Number(idx)] ?? '';
  });

  return work;
}

export const formatWhatsapp: Hook = {
  name: 'format-whatsapp',
  phase: 'AFTER_MODEL',

  async run(ctx: HarnessContext): Promise<HookResult> {
    const before = ctx.lastModelText ?? '';
    const after = formatWhatsappText(before);
    ctx.lastModelText = after;

    ctx.eventBus.emitHook(
      'format-whatsapp',
      'AFTER_MODEL',
      { before_len: before.length, after_len: after.length },
      'info',
    );

    return {};
  },
};
