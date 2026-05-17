// src/utils/follow-up-question.ts
//
// Bloco 2 — Task #13b da feature `follow-up-pendente`.
// Implementação da decisão D11' (substitui D11): detecção HÍBRIDA da
// categoria de follow-up + extração da última pergunta para o template
// genérico. 100% determinístico — sem LLM (invariante #3 trivialmente).
//
// Pipeline:
//
//   1. textoOutbound = última msg OUTBOUND não-redacted do contato.
//   2. categoria = detectarCategoriaPorRegex(textoOutbound)
//        ↳ 4 regex em ordem: tipo_evento → data → convidados → orcamento.
//        ↳ Primeira match ganha; retorna null se nenhuma bater.
//   3. SE categoria === null, fallback POR ESTADO DO LEAD:
//        ↳ event_type NULL  → tipo_evento
//        ↳ event_date NULL  → data
//        ↳ guest_count NULL → convidados
//        ↳ orcamento NÃO detectável por estado (coluna budget inexistente
//          em `leads` — confirmado via SQL ground-truth no Bloco 1).
//        ↳ caso contrário   → generico
//   4. SE categoria === 'generico', perguntaExtraida = extrairUltimaPergunta(textoOutbound):
//        (a) última frase terminada em '?', remove o '?' final.
//        (b) sem '?', pega as últimas 10 palavras da msg.
//
// Renderer (`templates/follow-up-message.ts`) consome `{categoria, perguntaExtraida?}`
// e monta `Oi {{nome}}! ` + `templates[categoria]`, interpolando
// `{{pergunta_extraida}}` quando categoria === 'generico'.

import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../db/client';
import { messages } from '../db/schema';
import type { FollowUpCategoria } from '../config/types';

// ─────────────────────────────────────────────────────────────────────────────
// Helper compartilhado: últimas N msgs formatadas (Cliente:/Angelina:)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê as últimas `limit` mensagens não-redacted do contato e formata como
 * bloco texto: `Cliente: ...` para INBOUND, `Angelina: ...` para OUTBOUND.
 * Trunca cada msg a `maxCharsPerMessage` chars (default 100) para evitar
 * vazar conteúdo sensível e manter o bloco compacto.
 *
 * Usado pelo Bloco 5 para `{{ultimas_5_msgs}}` no template de escalação ao
 * support (RF5). Determinístico (D11 herdado para uso interno; D11' substituiu
 * apenas a lógica de detecção de categoria, não a recuperação de contexto).
 *
 * Ordem do bloco: cronológica (mais antiga primeiro) — leitura natural.
 *
 * @returns String multilinha com `\n` entre msgs; vazia se contato não tem mensagens.
 */
export async function getLastNMessagesContext(
  contactId: string,
  limit = 5,
  maxCharsPerMessage = 100,
): Promise<string> {
  const rows = await db
    .select({
      text: messages.text,
      direction: messages.direction,
    })
    .from(messages)
    .where(
      and(eq(messages.contactId, contactId), isNull(messages.redactedAt)),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .map((m) => {
      const speaker = m.direction === 'INBOUND' ? 'Cliente' : 'Angelina';
      const raw = (m.text ?? '').trim();
      const truncated =
        raw.length > maxCharsPerMessage
          ? raw.slice(0, maxCharsPerMessage) + '…'
          : raw;
      return `${speaker}: ${truncated}`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Regex por categoria (D11') — ordem fixa, PT-BR
// ─────────────────────────────────────────────────────────────────────────────
//
// Heurística por palavras-chave que a Angelina usa ao perguntar sobre cada
// dimensão. Boundary `\b` evita falsos positivos em sub-strings.
// Flags `iu` — case-insensitive + Unicode (acentos contam).

const REGEX_TIPO_EVENTO =
  /\b(tipo|que tipo|qual evento|casamento|formatura|aniversário|aniversario|corporativo|festa|debutante|15\s*anos|sweet\s*15)\b/iu;

const REGEX_DATA =
  /\b(data|quando|dia|m[êe]s|disponibilidade|dispon[íi]vel|reservar|agenda)\b/iu;

const REGEX_CONVIDADOS =
  /\b(convidados|pessoas|quantos|quantas|capacidade)\b/iu;

const REGEX_ORCAMENTO =
  /\b(investimento|or[çc]amento|valor|pre[çc]o|faixa|custa|custo)\b/iu;

/**
 * Etapa 2 do pipeline — classifica por regex sobre o texto da última msg
 * OUTBOUND. Retorna `null` se nenhuma regex bater (caller deve aplicar
 * fallback por estado do lead).
 *
 * Função pura — sem I/O.
 */
export function detectarCategoriaPorRegex(
  textoOutbound: string,
): FollowUpCategoria | null {
  if (!textoOutbound) return null;
  // Ordem importa: tipo_evento e data têm overlap (ex: "casamento" pode
  // aparecer em frase sobre data); testamos tipo_evento primeiro para
  // priorizar a dimensão mais "alta" do funil.
  if (REGEX_TIPO_EVENTO.test(textoOutbound)) return 'tipo_evento';
  if (REGEX_DATA.test(textoOutbound)) return 'data';
  if (REGEX_CONVIDADOS.test(textoOutbound)) return 'convidados';
  if (REGEX_ORCAMENTO.test(textoOutbound)) return 'orcamento';
  return null;
}

/**
 * Conectivos iniciais (PT-BR) removidos do início da pergunta extraída para
 * fluir melhor após o prefixo "Conseguiu pensar sobre " do template `generico`.
 *
 * Exemplo: "E quantos convidados você espera" → "quantos convidados você espera".
 *
 * Lista mínima — apenas conectivos comuns no início de pergunta de
 * continuação que ficariam estranhos depois de "sobre".
 */
const REGEX_CONECTIVOS_INICIAIS =
  /^(e|ou|mas|ent[ãa]o|j[áa]|a[íi]|agora|t[áa]|ok|bem|pois|al[íi]as)\s+/iu;

/**
 * Etapa 5 do pipeline — extrai a pergunta para interpolar em `{{pergunta_extraida}}`
 * do template `generico`.
 *
 * (a) última frase terminada em `?` (sem o `?` final, trimmed) — depois remove
 *     conectivo inicial ("E", "Ou", "Mas", etc) e lower-case a 1ª letra.
 * (b) fallback: últimas 10 palavras da msg (sem `?`).
 *
 * Exemplos:
 *   "Ótimo! E quantos convidados você espera?" → "quantos convidados você espera"
 *   "Qual o tipo do evento?"                    → "qual o tipo do evento"
 *   "Vamos seguir com o cardápio" (sem ?)       → "vamos seguir com o cardápio"
 *
 * Função pura — sem I/O.
 */
export function extrairUltimaPergunta(texto: string): string {
  if (!texto) return '';
  const trimmed = texto.trim();

  // Caso (a): última frase com '?'.
  // Procura o último '?', depois encontra o início dessa frase olhando o último
  // terminator [.!?] anterior (ou início da string se não houver).
  const lastQuestionMarkIdx = trimmed.lastIndexOf('?');
  if (lastQuestionMarkIdx >= 0) {
    const upToMark = trimmed.slice(0, lastQuestionMarkIdx);
    const prevTerminatorMatch = upToMark.match(/[.!?](?=[^.!?]*$)/);
    const sentenceStart = prevTerminatorMatch
      ? (prevTerminatorMatch.index ?? -1) + 1
      : 0;
    let frase = trimmed.slice(sentenceStart, lastQuestionMarkIdx).trim();
    // Remove conectivo inicial ("E", "Ou", "Mas", etc).
    frase = frase.replace(REGEX_CONECTIVOS_INICIAIS, '');
    // Lower-case 1ª letra para fluir após "Conseguiu pensar sobre ".
    return frase.length > 0
      ? frase.charAt(0).toLowerCase() + frase.slice(1)
      : frase;
  }

  // Caso (b): sem '?', últimas 10 palavras (sem trim de conectivo — fallback raro).
  const palavras = trimmed.split(/\s+/).filter((w) => w.length > 0);
  const ultimas10 = palavras.slice(-10).join(' ');
  return ultimas10.length > 0
    ? ultimas10.charAt(0).toLowerCase() + ultimas10.slice(1)
    : ultimas10;
}

/**
 * Lê do banco a última mensagem OUTBOUND (não-redacted) do contato.
 * Retorna string vazia se não houver — o caller cai em `generico` com
 * `perguntaExtraida=''` (template fica "Conseguiu pensar sobre ?..." — caso
 * borderline raro; o checker filtra contatos sem OUTBOUND recente).
 */
export async function extrairUltimaPerguntaOutbound(
  contactId: string,
): Promise<string> {
  const rows = await db
    .select({ text: messages.text })
    .from(messages)
    .where(
      and(
        eq(messages.contactId, contactId),
        eq(messages.direction, 'OUTBOUND'),
        isNull(messages.redactedAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  return rows[0]?.text?.trim() ?? '';
}

/**
 * Snapshot do lead necessário para fallback por estado (etapa 3 do pipeline).
 * Apenas os 3 campos consultados — manter mínimo evita ciclo de tipos.
 */
export interface LeadStateForCategoryDetection {
  eventType: string | null;
  eventDate: string | Date | null;
  guestCount: number | null;
}

/**
 * Pipeline COMPLETO de detecção de categoria (D11'). Retorna a categoria
 * escolhida + `perguntaExtraida` quando aplicável (apenas em `generico`).
 *
 * Lê 1 row do banco (última msg OUTBOUND) — sem chamada ao LLM.
 *
 * @param contactId UUID do contato.
 * @param lead snapshot mínimo do lead (3 campos NULL-checkable).
 */
export async function detectarCategoria(
  contactId: string,
  lead: LeadStateForCategoryDetection,
): Promise<{ categoria: FollowUpCategoria; perguntaExtraida?: string }> {
  const textoOutbound = await extrairUltimaPerguntaOutbound(contactId);

  // Etapa 2 — regex.
  const porRegex = detectarCategoriaPorRegex(textoOutbound);
  if (porRegex !== null) {
    return porRegex === 'generico'
      ? { categoria: 'generico', perguntaExtraida: extrairUltimaPergunta(textoOutbound) }
      : { categoria: porRegex };
  }

  // Etapa 3 — fallback por estado do lead.
  if (lead.eventType == null) return { categoria: 'tipo_evento' };
  if (lead.eventDate == null) return { categoria: 'data' };
  if (lead.guestCount == null) return { categoria: 'convidados' };
  // orcamento não tem coluna no lead — só por regex.

  // Etapa 4 — generico com pergunta extraída.
  return {
    categoria: 'generico',
    perguntaExtraida: extrairUltimaPergunta(textoOutbound),
  };
}
