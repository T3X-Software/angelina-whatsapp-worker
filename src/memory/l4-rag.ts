// src/memory/l4-rag.ts
//
// Bloco 4 — Tasks #22-#27 da feature `rag-knowledge-population`.
//
// L4 = camada de conhecimento genérico (concept `memory-layers`). Busca top-K
// artigos de `knowledge_articles` por similaridade cosseno (pgvector) e formata
// uma seção `## Conhecimento relevante` para anexar ao system prompt do Claude.
//
// Estratégia (concept `rag-knowledge`):
//   1. shouldSkipRag(ctx, queryText) — 4 cenários de skip ANTES do embed
//      (economiza OpenAI):
//        a) empty_query: queryText vazio/whitespace
//        b) admin_command: queryText.startsWith('/')
//        c) handoff_blocked: lead em modo `blocked` (assisted ainda chama RAG —
//           IA segue falando, só algumas mensagens são substituídas pelo
//           response-guard; concept `assisted-handoff-mode`).
//        d) support_phone: ctx.contact.phone == agent_configs.support_whatsapp
//   2. loadL4Rag(ctx, queryText) — embed + query pgvector + filtro threshold.
//      Fail-open: qualquer erro emite trace `med` e retorna matches=[]
//      sem propagar. Composer NUNCA é bloqueado por falha de RAG.
//   3. formatRagSection(matches, maxTotalChars) — formata "## Conhecimento
//      relevante" respeitando max_chars_total_section (corta artigos do final
//      se overflow; nunca corta no meio do conteúdo de um artigo já incluído).
//
// Invariantes preservadas (CLAUDE.md raiz):
//   - #3 (hooks não chamam LLM): embed é query semântica determinística
//     (não chat completion). Decisão registrada no brief: "Embed ≠ LLM chat".
//   - #4 (tools não enviam mensagem): este módulo apenas LÊ knowledge_articles
//     e retorna matches; não envia nada.
//   - knowledge_articles RLS-fechada: query via service_role do Drizzle (db
//     client). NUNCA expor ao Claude via tool callable.
//   - Threshold 0.7 rígido (concept rag-knowledge): artigos abaixo são
//     descartados in-app, não retornados como fallback.
//
// Por que receber `ctx` (e não só campos isolados)?
//   - Acesso ao eventBus para tracing (padrão do worker).
//   - Acesso a ctx.config.hookParams.rag para config.
//   - Acesso a ctx.lead.id e ctx.contact.phone para skip rules.
//   - Padrão consistente com loadLastN/buildSummary que recebem IDs explícitos
//     mas L4 precisa de mais campos do ctx — passar ctx é mais limpo que 4
//     parâmetros individuais.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import { isSupportPhone } from '../edge/detect-support-inbound';
import { getLeadHandoffState } from '../utils/assisted-mode';
import { embedText } from '../utils/openai-embedding';
import type { HarnessContext } from '../harness/types';
import type {
  HandoffContinuityHookParams,
  KnowledgeArticleMatch,
  RagConfig,
} from '../config/types';

// ─────────────────────────────────────────────────────────────────────────────
// Defaults (usados quando agent_configs.hook_params.rag está ausente)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Defaults aplicados quando `ctx.config.hookParams.rag` está ausente.
 *
 * Bate com os valores canônicos da migration `20260510120000_rag_pipeline.sql`
 * — caso o worker rode contra um banco em config v3 (sem `rag` em hook_params)
 * ou um config futuro que omita o sub-objeto, o RAG ainda funciona com estes
 * valores. Emit `rag_config_missing` (low) sinaliza isso para observabilidade.
 */
export const DEFAULT_RAG_CONFIG: RagConfig = {
  top_k: 3,
  threshold: 0.7,
  model: 'text-embedding-3-small',
  max_chars_per_article: 600,
  max_chars_total_section: 2000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Razões discriminadas de skip / fail. Fechadas — todas as paths que pulam o
 * embed têm um valor aqui (facilita SQL agg em `traces.payload->>'reason'`).
 */
export type RagSkipReason =
  | 'empty_query'
  | 'admin_command'
  | 'handoff_blocked'
  | 'support_phone'
  | 'embed_failed'
  | 'query_failed';

export interface RagSkipDecision {
  skip: boolean;
  reason?: RagSkipReason;
}

/**
 * Resultado do `loadL4Rag`. Fail-open: se `skipped=true`, composer simplesmente
 * não anexa seção L4 e segue. NUNCA throw.
 *
 * `matches` ordenado por `similarity DESC` (mais relevante primeiro).
 */
export interface RagResult {
  matches: KnowledgeArticleMatch[];
  skipped: boolean;
  reason?: RagSkipReason;
}

/**
 * Dependency injection ponto único (Bloco 6 — feature `rag-knowledge-population`).
 *
 * Production: composer chama `loadL4Rag(ctx, queryText)` SEM deps — defaults
 * apontam para `embedText` e `getLeadHandoffState` reais. Zero churn no caller.
 *
 * Testes / smoke: passa `deps` com versões mockadas para isolar a lógica do
 * pipeline (skip rules, threshold, formatação) das dependências externas
 * (OpenAI, Postgres lookup do lead). Necessário porque tsx compila
 * `import { fn }` como destructuring em tempo de carga — mutação posterior
 * dos exports do módulo NÃO intercepta a chamada interna do `l4-rag.ts`.
 *
 * Mantemos `deps` opcional + tipos exatamente iguais aos das funções reais
 * para que TS pegue qualquer drift de assinatura.
 */
export interface L4RagDeps {
  embed?: typeof embedText;
  getHandoff?: typeof getLeadHandoffState;
}

// ─────────────────────────────────────────────────────────────────────────────
// shouldSkipRag — 4 cenários de skip (ordem importa)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide se o RAG deve ser skipado ANTES do embed (economiza OpenAI).
 *
 * **Ordem fixa** (concept `rag-knowledge`):
 *   1. empty_query     — input vazio/whitespace, nada a buscar.
 *   2. admin_command   — mensagem começa com `/` (admin-router já vai
 *                        short-circuitar; RAG não tem valor).
 *   3. handoff_blocked — lead em modo `blocked` (humano confirmou; IA muda).
 *   4. support_phone   — vendedor falando via canal de suporte.
 *
 * Modo `assisted` (humano disparou handoff mas ainda não confirmou) NÃO bloqueia
 * RAG — IA segue respondendo com restrições do response-guard, e RAG agrega
 * valor nas respostas factuais.
 */
export async function shouldSkipRag(
  ctx: HarnessContext,
  queryText: string,
  deps: L4RagDeps = {},
): Promise<RagSkipDecision> {
  const getHandoff = deps.getHandoff ?? getLeadHandoffState;

  // 1. empty_query
  const trimmed = (queryText ?? '').trim();
  if (trimmed.length === 0) {
    return { skip: true, reason: 'empty_query' };
  }

  // 2. admin_command — mensagem começa com `/`. Tolerante a whitespace antes.
  if (trimmed.startsWith('/')) {
    return { skip: true, reason: 'admin_command' };
  }

  // 3. handoff_blocked — lead em modo blocked (humano confirmou).
  // `assisted` não bloqueia: composer ainda quer L4; response-guard cuida das
  // restrições de saída.
  const leadId = ctx.lead?.id ?? null;
  if (leadId) {
    const state = await getHandoff(leadId);
    if (state.mode === 'blocked') {
      return { skip: true, reason: 'handoff_blocked' };
    }
  }

  // 4. support_phone — mensagem vinda do número do vendedor.
  // Helper isSupportPhone tolera string única OU array em supportWhatsapp.
  const supportConfig = ctx.config?.supportWhatsapp ?? null;
  if (isSupportPhone(ctx.contact.phone, supportConfig)) {
    return { skip: true, reason: 'support_phone' };
  }

  return { skip: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// loadL4Rag — embed + query + filtro threshold + tracing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linha "raw" lida de `knowledge_articles` na query top-K. Index signature
 * exigida pelo `db.execute<T>` constraint.
 */
interface RawKnowledgeRow {
  id: string;
  title: string;
  content: string;
  category: string | null;
  similarity: string | number;
  [key: string]: unknown;
}

/**
 * Pipeline RAG completo do turno. Fail-open em qualquer erro.
 *
 * Sequência:
 *   1. Lê config (com fallback p/ `DEFAULT_RAG_CONFIG` + emit `rag_config_missing`).
 *   2. shouldSkipRag → se skip, emit `rag_skipped` e early-return.
 *   3. embedText (try/catch — falha = `rag_embed_failed` med + early-return matches=[]).
 *   4. Emit `rag_query` (info) — turno consumiu OpenAI.
 *   5. Query pgvector top-K (try/catch — falha = `rag_query_failed` med + early-return).
 *   6. Filtra in-app por similarity >= threshold; trunca content por palavra.
 *   7. Emit `rag_match` (com `all_similarities` p/ tunagem futura — concept
 *      `divergencias-brief-vs-realidade`: dados crus ajudam ajustar threshold)
 *      OU `rag_no_match`.
 */
export async function loadL4Rag(
  ctx: HarnessContext,
  queryText: string,
  deps: L4RagDeps = {},
): Promise<RagResult> {
  const embed = deps.embed ?? embedText;
  // 1. Resolve config com fallback.
  const hookParams = (ctx.config?.hookParams ?? {}) as HandoffContinuityHookParams;
  let cfg: RagConfig;
  if (!hookParams.rag) {
    // Severity: brief sugeriu 'low' mas o tipo TraceSeverity do worker é
    // 'info' | 'med' | 'high'. Usamos 'info' — sinaliza ausência de config
    // sem alarmar; SQL agg pode filtrar por event_type='rag_config_missing'.
    ctx.eventBus.emit(
      'rag_config_missing',
      { used_defaults: true },
      'info',
    );
    cfg = DEFAULT_RAG_CONFIG;
  } else {
    // Defensive merge: campos individuais ausentes caem em defaults.
    cfg = {
      top_k: hookParams.rag.top_k ?? DEFAULT_RAG_CONFIG.top_k,
      threshold: hookParams.rag.threshold ?? DEFAULT_RAG_CONFIG.threshold,
      model: hookParams.rag.model ?? DEFAULT_RAG_CONFIG.model,
      max_chars_per_article:
        hookParams.rag.max_chars_per_article ??
        DEFAULT_RAG_CONFIG.max_chars_per_article,
      max_chars_total_section:
        hookParams.rag.max_chars_total_section ??
        DEFAULT_RAG_CONFIG.max_chars_total_section,
    };
  }

  // 2. Skip rules. Propaga `deps` para que mocks de getHandoff alcancem
  // shouldSkipRag também (sem isso, smoke do cenário "skip blocked"
  // chamaria a função real e a query iria ao DB).
  const skipDecision = await shouldSkipRag(ctx, queryText, deps);
  if (skipDecision.skip) {
    ctx.eventBus.emit(
      'rag_skipped',
      { reason: skipDecision.reason },
      'info',
    );
    return {
      matches: [],
      skipped: true,
      reason: skipDecision.reason,
    };
  }

  // 3. Embed (try/catch — fail-open).
  let queryVec: number[];
  try {
    queryVec = await embed(queryText, {
      model: cfg.model,
      eventBus: ctx.eventBus,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errClass = err instanceof Error ? err.constructor.name : typeof err;
    ctx.eventBus.emit(
      'rag_embed_failed',
      {
        error_class: errClass,
        error: msg,
      },
      'med',
    );
    return {
      matches: [],
      skipped: true,
      reason: 'embed_failed',
    };
  }

  // 4. Emit rag_query — embed sucesso (consumiu OpenAI; embedText já emitiu
  // `openai_embed_call`, mas `rag_query` é o evento RAG-level que SQL agg
  // costuma filtrar).
  ctx.eventBus.emit(
    'rag_query',
    {
      query_chars: queryText.length,
      model: cfg.model,
      top_k: cfg.top_k,
    },
    'info',
  );

  // 5. Query pgvector top-K. Cast literal `'[v1,v2,...]'::vector` é o padrão
  // portado quando o ORM não tem helper nativo de pgvector binding.
  const vectorLiteral = `[${queryVec.join(',')}]`;
  let rawRows: RawKnowledgeRow[];
  try {
    const result = await db.execute<RawKnowledgeRow>(sql`
      SELECT id::text                              AS id,
             title,
             content,
             category,
             1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM knowledge_articles
       WHERE published = true
       ORDER BY embedding <=> ${vectorLiteral}::vector
       LIMIT ${cfg.top_k}
    `);
    rawRows = Array.from(result) as RawKnowledgeRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errClass = err instanceof Error ? err.constructor.name : typeof err;
    ctx.eventBus.emit(
      'rag_query_failed',
      {
        error_class: errClass,
        error: msg,
      },
      'med',
    );
    return {
      matches: [],
      skipped: true,
      reason: 'query_failed',
    };
  }

  // 6. Normaliza similarity (postgres-js retorna numeric como string), filtra
  // por threshold, trunca content.
  //
  // Defensive (Bloco 5 task #30): cada row é validada antes de virar
  // KnowledgeArticleMatch. Rows com shape inesperado (id/title/content
  // ausentes ou tipo errado) são puladas com emit `rag_row_skipped` (info).
  // Cenários que isso protege:
  //   - Drizzle/postgres-js retornando campo com tipo diferente do esperado
  //     (ex.: bug de driver, schema drift entre prod e tipos).
  //   - knowledge_articles com row corrompida (title NULL, content NULL —
  //     não deveria acontecer pelo schema NOT NULL, mas defensive).
  //   - truncateByWords(undefined, n) explodir por content faltando.
  const allSimilarities: number[] = [];
  const matches: KnowledgeArticleMatch[] = [];
  let skippedRows = 0;
  for (const row of rawRows) {
    const sim =
      typeof row.similarity === 'number'
        ? row.similarity
        : parseFloat(String(row.similarity));
    allSimilarities.push(sim);
    if (!Number.isFinite(sim) || sim < cfg.threshold) continue;

    // Per-row shape guard. id/title/content são NOT NULL no schema, mas
    // confiar é diferente de validar. Se algo vier malformado, pula e segue.
    if (
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      typeof row.title !== 'string' ||
      typeof row.content !== 'string'
    ) {
      skippedRows += 1;
      ctx.eventBus.emit(
        'rag_row_skipped',
        {
          reason: 'invalid_shape',
          row_id: typeof row.id === 'string' ? row.id : null,
          has_title: typeof row.title === 'string',
          has_content: typeof row.content === 'string',
        },
        'info',
      );
      continue;
    }

    matches.push({
      id: row.id,
      title: row.title,
      content: truncateByWords(row.content, cfg.max_chars_per_article),
      category: row.category ?? '',
      similarity: sim,
    });
  }
  void skippedRows; // referência morta intencional — usada apenas em telemetria.

  // 7. Emit rag_match ou rag_no_match.
  if (matches.length > 0) {
    const categoriesHit = Array.from(
      new Set(matches.map((m) => m.category)),
    ).filter((c) => c.length > 0);
    ctx.eventBus.emit(
      'rag_match',
      {
        matches_count: matches.length,
        top_similarity: matches[0]!.similarity,
        categories_hit: categoriesHit,
        article_ids: matches.map((m) => m.id),
        all_similarities: allSimilarities,
      },
      'info',
    );
  } else {
    ctx.eventBus.emit(
      'rag_no_match',
      {
        all_similarities: allSimilarities,
        threshold: cfg.threshold,
      },
      'info',
    );
  }

  return { matches, skipped: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// formatRagSection — anexa ao system prompt do composer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formata os matches em uma seção `## Conhecimento relevante` para anexar ao
 * `composed.system`. Respeita `maxTotalChars` cortando ARTIGOS DO FINAL
 * (nunca no meio do conteúdo de um artigo já incluído — preserva integridade
 * factual de cada bloco).
 *
 * Retorna `''` quando não há matches — composer detecta e não anexa.
 *
 * Estrutura emitida:
 *   "\n\n## Conhecimento relevante\n\n### {title}\n{content}\n\n### {title}\n..."
 */
export function formatRagSection(
  matches: KnowledgeArticleMatch[],
  maxTotalChars: number = DEFAULT_RAG_CONFIG.max_chars_total_section,
): string {
  if (matches.length === 0) return '';

  const header = '\n\n## Conhecimento relevante\n\n';
  let section = header;
  let usedChars = header.length;

  for (const m of matches) {
    const block = `### ${m.title}\n${m.content}\n\n`;
    if (usedChars + block.length > maxTotalChars) {
      // Corta artigos do final — não trunca este bloco no meio (decisão de
      // design: artigo parcialmente truncado pode confundir o Claude).
      break;
    }
    section += block;
    usedChars += block.length;
  }

  // Se nenhum artigo coube (1º artigo já maior que maxTotalChars sozinho),
  // retorna vazio — composer não anexa header solto.
  if (usedChars === header.length) return '';

  return section;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trunca por palavras: nunca corta no meio de palavra. Se o conteúdo couber,
 * retorna intacto. Senão, corta na última palavra completa antes do limit.
 *
 * Compatível com a semântica usada em `scripts/embeddings-backfill.ts`.
 */
function truncateByWords(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  // Busca último whitespace antes do limit.
  let cut = content.lastIndexOf(' ', maxChars);
  if (cut < maxChars * 0.5) {
    // Defensivo: sem espaço razoável (ex: URL longa) — corta hard.
    cut = maxChars;
  }
  return content.slice(0, cut).trimEnd();
}
