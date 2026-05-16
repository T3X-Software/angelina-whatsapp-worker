// scripts/smoke-rag.ts
//
// SMOKE E2E PROGRAMÁTICO (Bloco 6 — feature `rag-knowledge-population`).
//
// 5 cenários cobrindo `loadL4Rag`, `shouldSkipRag` e `formatRagSection`
// (concept `rag-knowledge`). Determinístico — sem OpenAI real, sem Postgres
// real. Mocks via namespace mutation no module exports (esModuleInterop +
// CJS): substitui `embedText` e `getLeadHandoffState` antes de chamar
// `loadL4Rag`.
//
// Cenários:
//   A. Happy path     — embed mock + 3 rows do DB, 2 acima threshold → matches
//   B. No match       — embed mock + 3 rows com similarities baixas → 0 matches
//   C. Skip blocked   — getLeadHandoffState mock 'blocked' → skip sem embed
//   D. Skip admin     — queryText='/status' → skip sem embed
//   E. Embed fail     — embedText throws → rag_embed_failed (med) + skipped
//
// Rodar:
//   npx tsx scripts/smoke-rag.ts
//
// Output: tabela final PASS/FAIL por cenário + soma global. Exit 0 / 1 / 2.
//
// Por que esse smoke é "fixed" no repo (não descartável):
//   - L4 é caminho crítico do composer (anexado ao system prompt em todo turno
//     em que o cliente faz pergunta factual). Regressão silenciosa aqui
//     significaria respostas alucinadas em produção.
//   - Smoke real (`/feature-ship` Bloco 8) usa OpenAI vivo e Postgres remoto;
//     este aqui isola a lógica determinística para CI/pré-deploy.

import 'dotenv/config';

import { db } from '../src/db/client';
import {
  DEFAULT_RAG_CONFIG,
  formatRagSection,
  loadL4Rag,
  shouldSkipRag,
} from '../src/memory/l4-rag';
import type { L4RagDeps } from '../src/memory/l4-rag';
import type {
  EventBus,
  HarnessContext,
  TraceEvent,
  TraceSeverity,
  HookPhase,
} from '../src/harness/types';
import type { LeadHandoffState } from '../src/utils/assisted-mode';

// ─────────────────────────────────────────────────────────────────────────────
// Tabela de resultados
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  name: string;
  pass: number;
  fail: number;
  status: 'PASS' | 'FAIL';
}

const results: ScenarioResult[] = [];
let currentScenario: ScenarioResult | null = null;

function startScenario(id: string, name: string): void {
  currentScenario = { id, name, pass: 0, fail: 0, status: 'PASS' };
  console.log(`\n── Cenário ${id}: ${name} ──`);
}

function endScenario(): void {
  if (!currentScenario) return;
  currentScenario.status = currentScenario.fail === 0 ? 'PASS' : 'FAIL';
  results.push(currentScenario);
  currentScenario = null;
}

function assert(cond: boolean, name: string, detail?: unknown): void {
  if (!currentScenario) throw new Error('assert called outside scenario');
  if (cond) {
    currentScenario.pass++;
    console.log(`  PASS  ${name}`);
  } else {
    currentScenario.fail++;
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EventBus stub
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  severity: TraceSeverity;
  hookName?: string;
  toolName?: string;
}

function makeStubBus(): EventBus & { captured: CapturedEvent[] } {
  const captured: CapturedEvent[] = [];
  return {
    captured,
    emit(eventType, payload = {}, severity = 'info') {
      captured.push({ eventType, payload, severity });
    },
    emitHook(hookName, _phase: HookPhase, payload = {}, severity = 'info') {
      captured.push({
        eventType: 'hook',
        payload: { ...payload },
        severity,
        hookName,
      });
    },
    emitTool(toolName, eventType, payload = {}, severity = 'info') {
      captured.push({
        eventType,
        payload: { ...payload },
        severity,
        toolName,
      });
    },
    bindMessageId() {
      /* no-op */
    },
    async flushToDatabase() {
      return { inserted: 0 };
    },
    get events(): TraceEvent[] {
      return captured as unknown as TraceEvent[];
    },
  } as EventBus & { captured: CapturedEvent[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// `db.execute` stub
// ─────────────────────────────────────────────────────────────────────────────

const originalExecute = db.execute.bind(db);
let mockRows: unknown[] = [];
let dbExecuteCalls = 0;

function setDbMock(rows: unknown[]): void {
  mockRows = rows;
}

function resetDbCalls(): void {
  dbExecuteCalls = 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(db as any).execute = async (_query: unknown): Promise<unknown> => {
  dbExecuteCalls++;
  return mockRows;
};

// ─────────────────────────────────────────────────────────────────────────────
// Mocks por DI (Bloco 6) — `L4RagDeps` é exportado para esse exato uso.
//
// Composer em produção continua chamando `loadL4Rag(ctx, queryText)` sem deps
// (defaults apontam para `embedText` e `getLeadHandoffState` reais). O smoke
// injeta versões fake aqui.
// ─────────────────────────────────────────────────────────────────────────────

let embedCallCount = 0;
let embedMode: 'vector' | 'throw' = 'vector';
let handoffMockState: LeadHandoffState = { mode: 'free' };

const mockedDeps: L4RagDeps = {
  async embed(_text: string, _opts?: unknown): Promise<number[]> {
    embedCallCount++;
    if (embedMode === 'throw') {
      throw new Error('mock: OpenAI 500 Internal Server Error');
    }
    // Vetor 1536-d arbitrário — conteúdo NÃO importa porque `db.execute`
    // está mockado e retorna rows pré-fabricadas com similarity já definida.
    return new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0));
  },
  async getHandoff(_leadId: string | null | undefined): Promise<LeadHandoffState> {
    return handoffMockState;
  },
};

function setEmbedMode(mode: 'vector' | 'throw'): void {
  embedMode = mode;
}

function setHandoffMock(state: LeadHandoffState): void {
  handoffMockState = state;
}

function resetEmbedCalls(): void {
  embedCallCount = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder mínimo de HarnessContext
// ─────────────────────────────────────────────────────────────────────────────

interface MakeCtxOpts {
  contactId?: string;
  leadId?: string | null;
  contactPhone?: string;
  /** Sub-objeto `hook_params.rag` do agent_configs; null para testar
   *  fallback DEFAULT_RAG_CONFIG + emit `rag_config_missing`. */
  ragConfig?: Record<string, unknown> | null;
  supportWhatsapp?: string | string[] | null;
  messageText?: string;
}

function makeCtx(
  opts: MakeCtxOpts = {},
): HarnessContext & { eventBus: EventBus & { captured: CapturedEvent[] } } {
  const bus = makeStubBus();
  const hookParams: Record<string, unknown> = {};
  if (opts.ragConfig !== null && opts.ragConfig !== undefined) {
    hookParams.rag = opts.ragConfig;
  }
  return {
    turn: { id: `turn-${opts.contactId ?? 'x'}`, startedAt: Date.now() },
    contact: {
      id: opts.contactId ?? 'c-smoke',
      phone: opts.contactPhone ?? '5500000111111',
      name: 'SmokeContact',
      aiState: 'AUTO',
    },
    lead:
      opts.leadId === undefined
        ? { id: 'l-smoke', isHumanActive: false, classification: null }
        : opts.leadId === null
          ? null
          : { id: opts.leadId, isHumanActive: false, classification: null },
    message: {
      inboundId: `msg-${opts.contactId ?? 'x'}`,
      zapsterMessageId: `zap-${opts.contactId ?? 'x'}`,
      type: 'text',
      text: opts.messageText ?? '',
    },
    config: {
      // Apenas os campos lidos por `loadL4Rag`/`shouldSkipRag`. Cast forçado
      // — AgentConfigRow tem mais campos não relevantes para o smoke.
      hookParams,
      supportWhatsapp: opts.supportWhatsapp ?? null,
    } as unknown as HarnessContext['config'],
    payload: {} as HarnessContext['payload'],
    headers: {},
    eventBus: bus,
  } as HarnessContext & { eventBus: EventBus & { captured: CapturedEvent[] } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de inspeção
// ─────────────────────────────────────────────────────────────────────────────

function findEvent(
  captured: CapturedEvent[],
  type: string,
): CapturedEvent | undefined {
  return captured.find((e) => e.eventType === type);
}

function countEvents(captured: CapturedEvent[], type: string): number {
  return captured.filter((e) => e.eventType === type).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenário A — Happy path (3 rows DB, 2 acima threshold)
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioA(): Promise<void> {
  startScenario('A', 'Happy path — 3 rows DB, 2 acima threshold → rag_match');

  setEmbedMode('vector');
  setHandoffMock({ mode: 'free' });
  resetEmbedCalls();
  resetDbCalls();

  // 3 rows com similarities decrescentes; 0.85 e 0.78 acima do threshold 0.7;
  // 0.65 abaixo (filtrada in-app).
  setDbMock([
    {
      id: 'art-1',
      title: 'Gastronomia',
      content:
        'Chef Gisele formada no Le Cordon Bleu Paris assina o cardápio. Cozinha contemporânea com opções vegetarianas e veganas.',
      category: 'servicos',
      similarity: '0.85',
    },
    {
      id: 'art-2',
      title: 'Capacidade do espaço',
      content:
        'Comporta até 300+ convidados em formato cerimônia. Salões internos climatizados e área externa coberta.',
      category: 'capacidade',
      similarity: '0.78',
    },
    {
      id: 'art-3',
      title: 'Endereço',
      content: 'Rua das Flores, 123 — Campinas/SP.',
      category: 'institucional',
      similarity: '0.65',
    },
  ]);

  const ctx = makeCtx({
    contactId: 'c-A',
    leadId: 'l-A',
    messageText: 'qual o cardápio?',
    ragConfig: {
      top_k: 3,
      threshold: 0.7,
      model: 'text-embedding-3-small',
      max_chars_per_article: 600,
      max_chars_total_section: 2000,
    },
  });

  const result = await loadL4Rag(ctx, ctx.message.text ?? '', mockedDeps);

  assert(result.skipped === false, 'result.skipped === false');
  assert(
    result.matches.length === 2,
    `result.matches.length === 2 (got ${result.matches.length})`,
  );
  assert(
    result.matches[0]?.id === 'art-1' && result.matches[0]?.similarity === 0.85,
    'top match é art-1 com similarity 0.85 (numeric — string parseada)',
    result.matches[0],
  );
  assert(
    result.matches[1]?.id === 'art-2' && result.matches[1]?.similarity === 0.78,
    '2º match é art-2 com similarity 0.78',
    result.matches[1],
  );
  assert(
    embedCallCount === 1,
    `embedText chamado 1× (got ${embedCallCount})`,
  );
  assert(dbExecuteCalls === 1, `db.execute chamado 1× (got ${dbExecuteCalls})`);

  const ev = findEvent(ctx.eventBus.captured, 'rag_match');
  assert(ev !== undefined, 'rag_match emitido');
  assert(
    ev?.payload.matches_count === 2,
    `rag_match.matches_count === 2 (got ${String(ev?.payload.matches_count)})`,
  );
  assert(
    ev?.payload.top_similarity === 0.85,
    `rag_match.top_similarity === 0.85 (got ${String(ev?.payload.top_similarity)})`,
  );
  assert(
    Array.isArray(ev?.payload.all_similarities) &&
      (ev?.payload.all_similarities as number[]).length === 3,
    'rag_match.all_similarities tem 3 valores (TODOS retornados pelo DB)',
    ev?.payload.all_similarities,
  );

  // rag_query também deve estar presente.
  assert(
    findEvent(ctx.eventBus.captured, 'rag_query') !== undefined,
    'rag_query emitido (sinaliza consumo OpenAI)',
  );

  // formatRagSection: produz seção não-vazia com 2 ### blocks.
  const section = formatRagSection(result.matches, 2000);
  assert(
    section.startsWith('\n\n## Conhecimento relevante\n\n'),
    'formatRagSection começa com header `## Conhecimento relevante`',
  );
  assert(
    section.includes('### Gastronomia') && section.includes('### Capacidade do espaço'),
    'formatRagSection inclui ambos os títulos',
  );
  assert(
    !section.includes('### Endereço'),
    'formatRagSection NÃO inclui art-3 (foi filtrado pelo threshold)',
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenário B — No match (todas similarities abaixo do threshold)
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioB(): Promise<void> {
  startScenario('B', 'No match — 3 rows todas abaixo de 0.7 → rag_no_match');

  setEmbedMode('vector');
  setHandoffMock({ mode: 'free' });
  resetEmbedCalls();
  resetDbCalls();

  setDbMock([
    { id: 'x1', title: 'Algum', content: 'texto', category: 'faq', similarity: '0.40' },
    { id: 'x2', title: 'Outro', content: 'texto', category: 'faq', similarity: '0.30' },
    { id: 'x3', title: 'Mais', content: 'texto', category: 'faq', similarity: '0.20' },
  ]);

  const ctx = makeCtx({
    contactId: 'c-B',
    leadId: 'l-B',
    messageText: 'qual o horário do correio?',
    ragConfig: {
      top_k: 3,
      threshold: 0.7,
      model: 'text-embedding-3-small',
      max_chars_per_article: 600,
      max_chars_total_section: 2000,
    },
  });

  const result = await loadL4Rag(ctx, ctx.message.text ?? '', mockedDeps);

  assert(result.skipped === false, 'result.skipped === false (no_match ≠ skip)');
  assert(result.matches.length === 0, 'result.matches.length === 0');
  assert(embedCallCount === 1, 'embedText chamado 1× (query foi feita)');
  assert(dbExecuteCalls === 1, 'db.execute chamado 1× (query foi feita)');

  const ev = findEvent(ctx.eventBus.captured, 'rag_no_match');
  assert(ev !== undefined, 'rag_no_match emitido');
  assert(
    ev?.payload.threshold === 0.7,
    `rag_no_match.threshold === 0.7 (got ${String(ev?.payload.threshold)})`,
  );
  assert(
    Array.isArray(ev?.payload.all_similarities) &&
      (ev?.payload.all_similarities as number[]).length === 3,
    'rag_no_match.all_similarities tem 3 valores',
  );
  assert(
    findEvent(ctx.eventBus.captured, 'rag_match') === undefined,
    'rag_match NÃO emitido',
  );

  // formatRagSection vazia.
  assert(
    formatRagSection(result.matches) === '',
    'formatRagSection retorna string vazia quando matches=[]',
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenário C — Skip handoff_blocked (sem embed)
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioC(): Promise<void> {
  startScenario('C', 'Skip blocked — lead em modo `blocked` → sem embed');

  setEmbedMode('vector');
  setHandoffMock({
    mode: 'blocked',
    assumedAt: '2026-05-13T10:00:00Z',
  });
  resetEmbedCalls();
  resetDbCalls();
  setDbMock([]); // não deveria ser usado, mas defensive

  const ctx = makeCtx({
    contactId: 'c-C',
    leadId: 'l-C',
    messageText: 'qualquer pergunta',
    ragConfig: {
      top_k: 3,
      threshold: 0.7,
      model: 'text-embedding-3-small',
      max_chars_per_article: 600,
      max_chars_total_section: 2000,
    },
  });

  const result = await loadL4Rag(ctx, ctx.message.text ?? '', mockedDeps);

  assert(result.skipped === true, 'result.skipped === true');
  assert(
    result.reason === 'handoff_blocked',
    `result.reason === 'handoff_blocked' (got ${String(result.reason)})`,
  );
  assert(result.matches.length === 0, 'result.matches.length === 0');
  assert(
    embedCallCount === 0,
    `embedText NÃO chamado (got ${embedCallCount}) — economia OpenAI`,
  );
  assert(
    dbExecuteCalls === 0,
    `db.execute NÃO chamado (got ${dbExecuteCalls})`,
  );

  const ev = findEvent(ctx.eventBus.captured, 'rag_skipped');
  assert(ev !== undefined, 'rag_skipped emitido');
  assert(
    ev?.payload.reason === 'handoff_blocked',
    `rag_skipped.reason === 'handoff_blocked' (got ${String(ev?.payload.reason)})`,
  );
  assert(
    findEvent(ctx.eventBus.captured, 'rag_query') === undefined,
    'rag_query NÃO emitido (skip antes do embed)',
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenário D — Skip admin_command (sem embed)
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioD(): Promise<void> {
  startScenario('D', 'Skip admin — queryText `/status` → sem embed');

  setEmbedMode('vector');
  setHandoffMock({ mode: 'free' });
  resetEmbedCalls();
  resetDbCalls();
  setDbMock([]);

  const ctx = makeCtx({
    contactId: 'c-D',
    leadId: 'l-D',
    messageText: '/status',
    ragConfig: {
      top_k: 3,
      threshold: 0.7,
      model: 'text-embedding-3-small',
      max_chars_per_article: 600,
      max_chars_total_section: 2000,
    },
  });

  const result = await loadL4Rag(ctx, ctx.message.text ?? '', mockedDeps);

  assert(result.skipped === true, 'result.skipped === true');
  assert(
    result.reason === 'admin_command',
    `result.reason === 'admin_command' (got ${String(result.reason)})`,
  );
  assert(
    embedCallCount === 0,
    `embedText NÃO chamado (got ${embedCallCount})`,
  );

  const ev = findEvent(ctx.eventBus.captured, 'rag_skipped');
  assert(ev !== undefined, 'rag_skipped emitido');
  assert(
    ev?.payload.reason === 'admin_command',
    `rag_skipped.reason === 'admin_command' (got ${String(ev?.payload.reason)})`,
  );

  // Validação extra: shouldSkipRag direto também detecta admin_command.
  const directSkip = await shouldSkipRag(ctx, '/devolver abc', mockedDeps);
  assert(directSkip.skip === true, 'shouldSkipRag direto: skip=true');
  assert(
    directSkip.reason === 'admin_command',
    `shouldSkipRag direto: reason=admin_command (got ${String(directSkip.reason)})`,
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenário E — Embed fail (rag_embed_failed med)
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioE(): Promise<void> {
  startScenario('E', 'Embed fail — embedText throws → rag_embed_failed (med)');

  setEmbedMode('throw');
  setHandoffMock({ mode: 'free' });
  resetEmbedCalls();
  resetDbCalls();
  setDbMock([]); // não deveria ser usado

  const ctx = makeCtx({
    contactId: 'c-E',
    leadId: 'l-E',
    messageText: 'qual o cardápio?',
    ragConfig: {
      top_k: 3,
      threshold: 0.7,
      model: 'text-embedding-3-small',
      max_chars_per_article: 600,
      max_chars_total_section: 2000,
    },
  });

  const result = await loadL4Rag(ctx, ctx.message.text ?? '', mockedDeps);

  assert(result.skipped === true, 'result.skipped === true (fail-open)');
  assert(
    result.reason === 'embed_failed',
    `result.reason === 'embed_failed' (got ${String(result.reason)})`,
  );
  assert(result.matches.length === 0, 'result.matches.length === 0');
  assert(
    embedCallCount === 1,
    `embedText chamado 1× e jogou (got ${embedCallCount})`,
  );
  assert(
    dbExecuteCalls === 0,
    `db.execute NÃO chamado (got ${dbExecuteCalls}) — não tentamos query sem vetor`,
  );

  const ev = findEvent(ctx.eventBus.captured, 'rag_embed_failed');
  assert(ev !== undefined, 'rag_embed_failed emitido');
  assert(
    ev?.severity === 'med',
    `rag_embed_failed severity === 'med' (got ${String(ev?.severity)})`,
  );
  assert(
    typeof ev?.payload.error === 'string' &&
      (ev?.payload.error as string).includes('OpenAI 500'),
    'rag_embed_failed.error inclui mensagem do mock',
    ev?.payload.error,
  );
  assert(
    findEvent(ctx.eventBus.captured, 'rag_match') === undefined,
    'rag_match NÃO emitido',
  );

  // formatRagSection: vazia (matches=[]) — composer não anexaria nada.
  assert(
    formatRagSection(result.matches) === '',
    'formatRagSection vazia em fail (composer não anexa seção)',
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenário extra — rag_config_missing quando hook_params.rag ausente
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioConfigMissing(): Promise<void> {
  startScenario(
    'F',
    'Config missing — sem hook_params.rag → defaults + rag_config_missing',
  );

  setEmbedMode('vector');
  setHandoffMock({ mode: 'free' });
  resetEmbedCalls();
  resetDbCalls();
  setDbMock([
    {
      id: 'art-1',
      title: 'Algum',
      content: 'texto curto',
      category: 'faq',
      similarity: '0.80',
    },
  ]);

  const ctx = makeCtx({
    contactId: 'c-F',
    leadId: 'l-F',
    messageText: 'pergunta qualquer',
    ragConfig: null, // hook_params.rag AUSENTE
  });

  const result = await loadL4Rag(ctx, ctx.message.text ?? '', mockedDeps);

  assert(result.skipped === false, 'result.skipped === false (defaults aplicados)');
  assert(result.matches.length === 1, 'result.matches.length === 1');

  const ev = findEvent(ctx.eventBus.captured, 'rag_config_missing');
  assert(ev !== undefined, 'rag_config_missing emitido');
  assert(
    ev?.payload.used_defaults === true,
    'rag_config_missing.used_defaults === true',
  );
  assert(
    DEFAULT_RAG_CONFIG.threshold === 0.7,
    'DEFAULT_RAG_CONFIG.threshold === 0.7 (sanity check)',
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' SMOKE PROGRAMÁTICO — rag-knowledge-population (Bloco 6)');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
    await scenarioConfigMissing();
  } finally {
    // Restaura db.execute. embed/getHandoff são injetados via deps em cada
    // chamada — os módulos originais nunca foram tocados.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).execute = originalExecute;
  }

  // ─── Tabela final ───────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' TABELA FINAL');
  console.log('═══════════════════════════════════════════════════════════════');
  let totalPass = 0;
  let totalFail = 0;
  let cenariosFail = 0;

  for (const r of results) {
    const tag = r.status === 'PASS' ? '✓' : '✗';
    console.log(
      ` ${tag} #${r.id}  ${r.status}  ${r.pass}/${r.pass + r.fail}  — ${r.name}`,
    );
    totalPass += r.pass;
    totalFail += r.fail;
    if (r.status === 'FAIL') cenariosFail++;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(
    ` SUMÁRIO: ${results.length - cenariosFail}/${results.length} cenários PASS  |  ${totalPass}/${totalPass + totalFail} asserts PASS`,
  );
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke crashed:', err);
  process.exit(2);
});
