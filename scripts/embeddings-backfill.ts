// scripts/embeddings-backfill.ts
//
// Bloco 3 — Tasks #15-#18 da feature `rag-knowledge-population`.
//
// Pipeline:
//   1. Lê LEGADO/docs/base-conhecimento-agente.md (path absoluto resolvido
//      relative ao cwd do worker).
//   2. Parser markdown:
//        - Extrai blocos H2 e seus H3 internos.
//        - H2 com H3s → 1 artigo por H3 (title=H3, content=tudo até próximo
//          header, category=mapping(H2)).
//        - H2 sem H3 → 1 artigo flat (title=H2, content=corpo, category=mapping).
//        - H2 "Perguntas Frequentes (FAQ)" → IGNORA H3 sub-categórico, extrai
//          1 artigo por par Q/A (title=texto da Q, content="Q: ...\nA: ...",
//          category='faq').
//   3. Mapeamento canônico H2 → category (7 categorias). Se H2 desconhecido,
//      script ABORTA (sinaliza drift entre brief e fonte).
//   4. Trunca content para `MAX_CHARS_PER_ARTICLE` (600) por palavra (não corta
//      no meio de palavra). Loga ⚠ se truncou.
//   5. Embeda cada artigo SEQUENCIALMENTE via `embedText` (rate-limit-friendly,
//      simplicidade). Coleta TODOS os vetores antes de tocar no banco —
//      all-or-nothing: qualquer falha aborta sem DELETE.
//   6. Pré-DELETE check: se `knowledge_articles` tiver rows → ABORTA (driver
//      do feature-implement faz a confirmação manualmente; este script é
//      defensivo, nunca destrói dados sem confirmação humana via env flag).
//   7. Transação Drizzle: DELETE FROM knowledge_articles + INSERT batch dos
//      ~26 artigos novos. Idempotente — re-rodar não duplica (DELETE limpa,
//      INSERT recria com mesmos titles).
//   8. Log final: count + distribuição por categoria + latência total.
//
// Uso:
//   cd whatsapp-worker
//   npm run embeddings:backfill                      # falha se já houver rows
//   ALLOW_DESTRUCTIVE=1 npm run embeddings:backfill  # permite DELETE (re-run)
//
// Invariantes preservadas:
//   - Migration nunca editada (#8) — backfill é DML, não DDL.
//   - Hook não chama LLM (#3) — embeddings é query semântica determinística.

import 'dotenv/config';

import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';

import { db, closeDb } from '../src/db/client';
import { knowledgeArticles } from '../src/db/schema';
import { embedText } from '../src/utils/openai-embedding';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bate com `agent_configs.hook_params.rag.max_chars_per_article` da migration
 * 20260510120000_rag_pipeline. Truncar aqui no backfill é defensivo: o composer
 * também trunca em runtime, mas guardar conteúdo já enxuto evita mismatch
 * entre o que foi embedado e o que será exibido.
 */
const MAX_CHARS_PER_ARTICLE = 600;

/**
 * Mapeamento canônico H2 → category. 7 categorias decididas no plan
 * (decisão #12 do `decisions.md`). Aceitamos também variações próximas ao
 * texto literal do markdown (ex: "Tipos de Eventos Atendidos" vs "Tipos de
 * Eventos") para evitar drift trivial entre brief e fonte real.
 */
const H2_TO_CATEGORY: Array<{ match: RegExp; category: string }> = [
  { match: /^Informações Institucionais$/i, category: 'institucional' },
  { match: /^Tipos de Eventos( Atendidos)?$/i, category: 'eventos' },
  { match: /^Capacidade e Estrutura$/i, category: 'capacidade' },
  { match: /^Serviços Oferecidos$/i, category: 'servicos' },
  { match: /^Diferenciais Competitivos$/i, category: 'diferenciais' },
  { match: /^Formas de Pagamento$/i, category: 'pagamento' },
  { match: /^Perguntas Frequentes( \(FAQ\))?$/i, category: 'faq' },
];

/**
 * Path do markdown-fonte. Resolvido relative ao __dirname (scripts/) → sobe 3
 * níveis até o root do monorepo Espaço Angelinos.
 *   whatsapp-worker/scripts/embeddings-backfill.ts
 *   → ../../LEGADO/docs/base-conhecimento-agente.md (relative ao cwd)
 *
 * O cwd quando rodando via `npm run embeddings:backfill` é
 * `whatsapp-worker/`. Logo `../LEGADO/docs/...` resolve corretamente do cwd.
 */
const MARKDOWN_PATH_FROM_WORKER = '../LEGADO/docs/base-conhecimento-agente.md';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedArticle {
  title: string;
  content: string;
  category: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapeia título do H2 (sem `## `) para uma das 7 categorias canônicas.
 * Lança se não casa — driver pega o erro e aborta antes do DELETE.
 */
function categoryFromH2(h2Title: string): string {
  const trimmed = h2Title.trim();
  // Remove prefixos numerados como "1. " ou "7. ".
  const stripped = trimmed.replace(/^\d+\.\s+/, '');
  for (const entry of H2_TO_CATEGORY) {
    if (entry.match.test(stripped)) return entry.category;
  }
  throw new Error(
    `[parser] H2 "${h2Title}" não mapeia para nenhuma das 7 categorias canônicas. ` +
      `Atualize H2_TO_CATEGORY ou corrija o markdown-fonte.`,
  );
}

/**
 * Quebra o markdown em blocos H2. Retorna [{ title, body }] onde body é o
 * texto desde a linha após o `## ...` até o próximo `## ` (exclusivo) ou EOF.
 * Ignora linhas antes do primeiro H2 (header `# ...`, blockquote, separadores).
 */
function splitH2Sections(md: string): Array<{ title: string; body: string }> {
  const lines = md.split(/\r?\n/);
  const sections: Array<{ title: string; body: string }> = [];
  let current: { title: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (current) {
        sections.push({ title: current.title, body: current.bodyLines.join('\n') });
      }
      current = { title: h2[1]!.trim(), bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) {
    sections.push({ title: current.title, body: current.bodyLines.join('\n') });
  }
  return sections;
}

/**
 * Quebra o body de um H2 em sub-blocos H3 (### ...).
 * Retorna { intro, h3s }: `intro` é o texto antes do primeiro H3 (geralmente
 * vazio para sections com H3, mas pode conter conteúdo introdutório).
 * `h3s` é [{ title, body }] análogo a `splitH2Sections`.
 */
function splitH3Sections(body: string): {
  intro: string;
  h3s: Array<{ title: string; body: string }>;
} {
  const lines = body.split(/\r?\n/);
  const introLines: string[] = [];
  const h3s: Array<{ title: string; body: string }> = [];
  let seenFirstH3 = false;
  let current: { title: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      seenFirstH3 = true;
      if (current) {
        h3s.push({ title: current.title, body: current.bodyLines.join('\n') });
      }
      current = { title: h3[1]!.trim(), bodyLines: [] };
      continue;
    }
    if (seenFirstH3 && current) {
      current.bodyLines.push(line);
    } else {
      introLines.push(line);
    }
  }
  if (current) {
    h3s.push({ title: current.title, body: current.bodyLines.join('\n') });
  }
  return { intro: introLines.join('\n'), h3s };
}

/**
 * Limpa um corpo: remove linhas em branco redundantes nas pontas, blockquotes
 * decorativos (`> ...`) e separadores horizontais (`---`). Mantém quebras
 * internas e listas — preserva semântica.
 */
function cleanBody(body: string): string {
  return body
    .replace(/^\s*---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Trunca por palavras: nunca corta no meio de palavra. Se o resultado ficar
 * acima de `maxChars`, encurta até a última palavra completa que cabe.
 * Retorna { truncated, originalChars }.
 */
function truncateByWords(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean; originalChars: number } {
  const original = content;
  if (original.length <= maxChars) {
    return { content: original, truncated: false, originalChars: original.length };
  }
  // Encontra último whitespace antes do limit.
  let cut = original.lastIndexOf(' ', maxChars);
  if (cut < maxChars * 0.5) {
    // Defensivo: se não tem espaço razoável, corta hard no maxChars.
    cut = maxChars;
  }
  return {
    content: original.slice(0, cut).trimEnd(),
    truncated: true,
    originalChars: original.length,
  };
}

/**
 * Extrai pares Q/A do body do FAQ. Cada `**Q: ...?**` seguido de `A: ...`
 * (que pode ter múltiplas linhas até o próximo `**Q:` ou `### ` ou EOF) vira
 * 1 artigo: title=texto da pergunta sem prefixo "Q: ", content="Q: ...\nA: ...".
 *
 * H3s sub-categóricos (Estrutura, Gastronomia, Comercial, Assessoria) são
 * IGNORADOS — todos os Q/A viram artigos planos com category='faq'.
 */
function extractFAQPairs(faqBody: string): Array<{ title: string; content: string }> {
  // Remove os ### sub-categóricos para normalizar — flatten.
  const flat = faqBody.replace(/^###\s+.+$/gm, '');
  // Regex: `**Q: ...?**` (multilinha não, single line) seguido de `A: ...`
  // até o próximo `**Q:` ou `###` ou EOF. Flag `s` faria `.` casar `\n`.
  const pairRegex = /\*\*Q:\s*([^*]+?)\*\*\s*\n\s*A:\s*([\s\S]+?)(?=\n\s*\*\*Q:|\n\s*###|\n\s*---|\Z|$)/g;
  // Ajuste: como `\Z` não é suportado em JS, capturamos até o próximo `**Q:`/`###`/`---` OU final via fallback.
  const pairs: Array<{ title: string; content: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(flat)) !== null) {
    const question = m[1]!.trim();
    const answer = m[2]!.trim();
    pairs.push({
      title: question.endsWith('?') ? question : `${question}?`,
      content: `Q: ${question}\nA: ${answer}`,
    });
  }
  return pairs;
}

/**
 * Top-level parser: markdown → ParsedArticle[].
 *
 * H2s sem prefixo numerado ("1. ...", "2. ...") são tratados como subtítulos
 * de capa do documento (ex: "## Espaço Angelino's" logo após o H1) e
 * IGNORADOS. Apenas H2s numerados são processados como seções de conteúdo.
 */
function parseMarkdown(md: string): ParsedArticle[] {
  const articles: ParsedArticle[] = [];
  const h2Sections = splitH2Sections(md);

  for (const h2 of h2Sections) {
    // Filtra subtítulos do header (sem prefixo "N. ").
    if (!/^\d+\.\s+/.test(h2.title)) {
      continue;
    }
    const category = categoryFromH2(h2.title);

    // Caso especial: FAQ → Q/A pairs (ignora H3 sub-categóricos).
    if (category === 'faq') {
      const pairs = extractFAQPairs(h2.body);
      if (pairs.length === 0) {
        throw new Error(
          `[parser] H2 "${h2.title}" mapeou para 'faq' mas extractFAQPairs ` +
            `retornou 0 pares. Verifique formato **Q: ... ?**\\nA: ... no markdown-fonte.`,
        );
      }
      for (const p of pairs) {
        articles.push({ title: p.title, content: p.content, category });
      }
      continue;
    }

    const { intro, h3s } = splitH3Sections(h2.body);

    if (h3s.length === 0) {
      // H2 flat: 1 artigo, title = H2 sem prefixo numérico, content = body limpo.
      const title = h2.title.replace(/^\d+\.\s+/, '').trim();
      const content = cleanBody(intro || h2.body);
      if (content.length > 0) {
        articles.push({ title, content, category });
      }
      continue;
    }

    for (const h3 of h3s) {
      const content = cleanBody(h3.body);
      if (content.length === 0) continue;
      articles.push({ title: h3.title, content, category });
    }
  }

  return articles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pré-checagens defensivas
// ─────────────────────────────────────────────────────────────────────────────

async function fetchExistingCount(): Promise<number> {
  const rows = await db.execute(sql`SELECT COUNT(*)::int AS n FROM knowledge_articles`);
  // postgres-js retorna array de objects; primeiro row tem `n`.
  // Compatível com Drizzle's execute helper.
  const n = (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline principal
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t0 = performance.now();

  // 1. Resolve path do markdown.
  // O cwd é `whatsapp-worker/`. Caminho relativo do monorepo: ../LEGADO/...
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const mdPath = resolve(__dirname, '..', '..', 'LEGADO', 'docs', 'base-conhecimento-agente.md');
  console.log(`[backfill] lendo markdown: ${mdPath}`);
  const md = readFileSync(mdPath, 'utf8');
  console.log(`[backfill] markdown carregado: ${md.length} chars`);

  // 2. Parse.
  const parsed = parseMarkdown(md);
  console.log(`[backfill] parsed: ${parsed.length} artigos`);

  if (parsed.length === 0) {
    console.error('[backfill] FATAL: 0 artigos parseados. Abort.');
    process.exit(1);
  }

  // Distribuição por category — sanity check antes de embed.
  const distPre: Record<string, number> = {};
  for (const a of parsed) distPre[a.category] = (distPre[a.category] ?? 0) + 1;
  console.log('[backfill] distribuição por categoria:', distPre);

  // 3. Trunca content + warn.
  const truncatedArticles: ParsedArticle[] = [];
  for (const a of parsed) {
    const r = truncateByWords(a.content, MAX_CHARS_PER_ARTICLE);
    if (r.truncated) {
      console.warn(
        `⚠ truncated: "${a.title}" (${r.originalChars} → ${r.content.length} chars)`,
      );
    }
    truncatedArticles.push({ ...a, content: r.content });
  }

  // 4. Embed sequencial (all-or-nothing). Coleta antes do banco.
  console.log(`[backfill] embedando ${truncatedArticles.length} artigos sequencialmente...`);
  const tEmbed0 = performance.now();
  const enriched: Array<ParsedArticle & { embedding: number[] }> = [];
  try {
    for (let i = 0; i < truncatedArticles.length; i++) {
      const a = truncatedArticles[i]!;
      const t = performance.now();
      const vec = await embedText(a.content);
      const ms = Math.round(performance.now() - t);
      console.log(
        `  [${i + 1}/${truncatedArticles.length}] "${a.title.slice(0, 60)}" → ${ms}ms`,
      );
      enriched.push({ ...a, embedding: vec });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[backfill] FATAL: embed falhou em "${enriched.length + 1}/${truncatedArticles.length}". ` +
        `Erro: ${msg}. NENHUM dado tocado no banco. Abort.`,
    );
    await closeDb();
    process.exit(1);
  }
  const embedTotalMs = Math.round(performance.now() - tEmbed0);
  console.log(`[backfill] todos os ${enriched.length} embeds OK em ${embedTotalMs}ms total.`);

  // 5. Pré-DELETE check defensivo.
  const existing = await fetchExistingCount();
  if (existing > 0 && process.env['ALLOW_DESTRUCTIVE'] !== '1') {
    console.error(
      `[backfill] ABORT: knowledge_articles já tem ${existing} rows. ` +
        `Para autorizar DELETE+INSERT, rode com ALLOW_DESTRUCTIVE=1.`,
    );
    await closeDb();
    process.exit(2);
  }
  if (existing > 0) {
    console.log(
      `[backfill] ALLOW_DESTRUCTIVE=1 detectado — DELETE + INSERT autorizado (${existing} rows existentes serão substituídas).`,
    );
  } else {
    console.log('[backfill] tabela vazia — INSERT direto, sem DELETE.');
  }

  // 6. Transação: DELETE + INSERT batch.
  const rows = enriched.map((a) => ({
    title: a.title,
    content: a.content,
    category: a.category,
    // Drizzle vector type aceita number[] direto.
    embedding: a.embedding,
    published: true,
  }));

  await db.transaction(async (tx) => {
    if (existing > 0) {
      await tx.delete(knowledgeArticles);
    }
    await tx.insert(knowledgeArticles).values(rows);
  });

  // 7. Verificação pós-INSERT.
  const finalCount = await fetchExistingCount();
  const totalMs = Math.round(performance.now() - t0);
  console.log(
    `[backfill] ✓ ${finalCount} artigos em knowledge_articles. ` +
      `Total: ${totalMs}ms (embed=${embedTotalMs}ms, parse+db=${totalMs - embedTotalMs}ms).`,
  );

  // Distribuição final via SQL (independente do parser — ground truth).
  const distRows = (await db.execute(
    sql`SELECT category, COUNT(*)::int AS n FROM knowledge_articles GROUP BY category ORDER BY n DESC`,
  )) as unknown as Array<{ category: string | null; n: number }>;
  console.log('[backfill] distribuição final (DB):');
  for (const r of distRows) {
    console.log(`  ${r.category ?? '(null)'}: ${r.n}`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error('[backfill] erro não tratado:', err instanceof Error ? err.stack : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
