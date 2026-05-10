// src/harness/types.ts
//
// Bloco 5 — Task 25.
//
// Tipos compartilhados pela harness (loop, hooks, tools, event-bus).
// Estes tipos descrevem o CONTRATO entre as peças — implementações
// reais de hooks/tools/LLM virão nos Blocos 6-9, mas a forma é fixada
// aqui para que o esqueleto do `loop.ts` (Task 29) possa ser escrito
// com tipagem completa.

import type { z } from 'zod';
import type { WebhookPayload } from '../edge/payload';
import type { agentConfigs } from '../db/schema';
import type { InferSelectModel } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
// Identificadores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identificador do turno na harness.
 *
 * **Decisão registrada** (log Bloco 5 — task #26): o `turnId` é o `messages.id`
 * do INSERT inicial inbound. Isso alinha com `traces.message_id` no schema real
 * (a tabela `traces` NÃO tem coluna `turn_id` separada — ver decisão 22:42).
 *
 * Quando ainda não temos messageId (antes de `claimMessage`), usamos
 * `randomUUID()` como placeholder; o loop substitui imediatamente após
 * o INSERT inbound.
 */
export type TurnId = string;

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fases do hook pipeline (concept `hook-pipeline`).
 *
 * Ordem imutável global:
 *   BEFORE_REQUEST → (LLM call) → AFTER_MODEL → (INSERT outbound) → BEFORE_SEND
 *
 * Invariantes (CLAUDE.md raiz):
 *   - rate-limit-guard é SEMPRE o primeiro de BEFORE_REQUEST
 *   - response-guard é SEMPRE o último de BEFORE_SEND
 *   - hooks NÃO chamam LLM
 *   - tools NÃO enviam mensagem
 */
export type HookPhase = 'BEFORE_REQUEST' | 'AFTER_MODEL' | 'BEFORE_SEND';

export interface HookResult {
  /** Se true, interrompe o pipeline; resposta (se houver) é o output final do turno. */
  shortCircuit?: boolean;
  /** Texto a enviar (em caso de short-circuit) ou texto a substituir o output do LLM. */
  response?: string;
  /** Patches a aplicar no contexto (mutação controlada do HarnessContext). */
  contextUpdate?: Partial<HarnessContext>;
}

export interface Hook {
  name: string;
  phase: HookPhase;
  run: (ctx: HarnessContext) => Promise<HookResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  execute: (input: I, ctx: HarnessContext) => Promise<ToolResult<O>>;
}

/**
 * Tool com tipos apagados — usado pelo registry/dispatcher porque Tool<I, O>
 * é invariante em I (parâmetro contravariante). Em runtime, o input já passa
 * por `tool.inputSchema.safeParse` antes do `execute`, então a perda de
 * type safety estática está coberta.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any>;

// ─────────────────────────────────────────────────────────────────────────────
// Configs / row do banco
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linha completa de `agent_configs` (Drizzle InferSelectModel).
 * `null` quando o turno está em `agent_inactive` (flag `is_active=false`).
 */
export type AgentConfigRow = InferSelectModel<typeof agentConfigs>;

// ─────────────────────────────────────────────────────────────────────────────
// EventBus (forward-declared — implementação em event-bus.ts / Task 26)
// ─────────────────────────────────────────────────────────────────────────────

export type TraceSeverity = 'info' | 'med' | 'high';

/**
 * Estrutura interna de um evento antes do flush.
 *
 * Mapeamento para colunas reais de `traces` (decisão 22:42):
 *   eventType    → traces.event_type
 *   payload      → traces.payload (NOT NULL DEFAULT '{}')
 *                  inclui `severity` dentro do JSON (não tem coluna dedicada)
 *   messageId    → traces.message_id (FK; serve de "turn_id")
 *   contactId    → traces.contact_id
 *   leadId       → traces.lead_id (NULL quando contato sem lead)
 *   phase        → traces.phase
 *   hookName     → traces.hook_name
 *   toolName     → traces.tool_name
 *   latencyMs    → traces.latency_ms
 *   error        → traces.error (jsonb)
 *   createdAt    → traces.created_at (default now() — não preenchemos client-side)
 */
export interface TraceEvent {
  eventType: string;
  payload: Record<string, unknown>;
  messageId: string | null;
  contactId: string | null;
  leadId: string | null;
  phase?: HookPhase;
  hookName?: string;
  toolName?: string;
  latencyMs?: number;
  error?: Record<string, unknown> | null;
}

export interface EventBus {
  /** Emite um evento (ainda em memória; só vai pro DB no `flushToDatabase`). */
  emit(
    eventType: string,
    payload?: Record<string, unknown>,
    severity?: TraceSeverity,
  ): void;

  /** Helper opcional: emite trace já com phase/hookName preenchidos. */
  emitHook(
    hookName: string,
    phase: HookPhase,
    payload?: Record<string, unknown>,
    severity?: TraceSeverity,
  ): void;

  /** Helper opcional: emite trace já com toolName preenchido. */
  emitTool(
    toolName: string,
    eventType: string,
    payload?: Record<string, unknown>,
    severity?: TraceSeverity,
  ): void;

  /** Substitui o messageId âncora (usado depois do `claimMessage`). */
  bindMessageId(messageId: string): void;

  /**
   * Persistência batch — 1 round-trip se houver eventos. Idempotente
   * (no-op se já flushou ou se array vazio). Erros são logados, NUNCA
   * propagados (não pode quebrar o turno).
   */
  flushToDatabase(): Promise<{ inserted: number }>;

  /** Snapshot read-only para inspeção em testes. */
  readonly events: ReadonlyArray<TraceEvent>;
}

// ─────────────────────────────────────────────────────────────────────────────
// HarnessContext — passado por toda a pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface HarnessContext {
  turn: {
    id: TurnId;
    startedAt: number; // Date.now() para latência total
  };

  contact: {
    id: string;
    phone: string;
    /** `contacts.name` — pode ser placeholder `WhatsApp <phone>`. O composer
     *  usa para decidir se pede o nome ao cliente. Pode ser mutado in-place
     *  no mesmo turno por `save_lead_info(contact_name=…)`. */
    name: string;
    aiState: 'AUTO' | 'PAUSED' | 'HUMAN_TAKEOVER' | 'AFTER_HOURS_OK';
  };

  lead: {
    id: string;
    isHumanActive: boolean;
    classification?: string | null;
    /** Campos qualificadores hidratados pelo loop antes de BEFORE_REQUEST.
     *  Consumidos por: (a) `transfer-trigger` ramo (b); (b) `composer.compose()`
     *  para a seção `## Estado do lead atual` do system prompt
     *  (alinhamento com contrato `load-context` do Harness-Architecture). */
    eventType?: string | null;
    eventDate?: string | null;
    guestCount?: number | null;
    estimatedBudget?: string | null;
    preferences?: string | null;
    notes?: string | null;
    visitScheduledAt?: string | null;
  } | null;

  /** Candidatos de lead quando o contato tem 2+ leads OPEN ao mesmo tempo
   *  (atendimento ambíguo). Quando preenchido, `ctx.lead === null` e o
   *  composer renderiza a seção `## Leads ativos do contato (atendimento
   *  ambíguo)` no lugar de `## Estado do lead atual`, instruindo a Angelina
   *  a perguntar qual evento antes de qualquer ação. Vazio/undefined nos
   *  cenários 0 lead e 1 lead (caminho original — sem regressão). */
  leadCandidates?: Array<{
    id: string;
    classification: string | null;
    eventType: string | null;
    eventDate: string | null;
    guestCount: number | null;
    lastActivityAt: string | null;
  }>;

  message: {
    /** ID do INSERT inbound (uuid em messages.id). */
    inboundId: string;
    /** ID do payload Zapster (data.message.id). */
    zapsterMessageId: string;
    text?: string;
    type: string;
  };

  /** Config ativa de Angelina; `null` quando `is_active=false` (agent_inactive). */
  config: AgentConfigRow | null;

  /**
   * Memória composta (Bloco 10).
   *
   * - `l1`: histórico cronológico das últimas N mensagens já mapeadas em
   *   `LLMMessage[]` (compatível com Anthropic SDK). Tipo `unknown[]` aqui
   *   evita ciclo de import com `../llm/types` no harness/types — o consumer
   *   real (loop.ts) faz cast para `LLMMessage[]`.
   * - `l2`: sumário em PT-BR derivado de `contact_facts` (vazio se 0 facts).
   * - `system`: prompt completo (base + L2 + contexto temporal). Pré-montado
   *   pelo composer para o callClaude consumir direto.
   * - `tokenEstimate`: estimativa grosseira (chars/4) — útil para tracing.
   */
  memory?: {
    l1: unknown[];
    l2: string;
    system?: string;
    tokenEstimate?: number;
  };

  payload: WebhookPayload;
  headers: Record<string, string | undefined>;

  /** Sinal HOT handoff (transfer-trigger lê — Bloco 6 task 36).
   *  Bloco 7: setado pelo loop quando `transfer_to_human` retorna
   *  `ToolResult.data.trigger_handoff===true`. */
  handoffRequested?: boolean;

  /**
   * Última tool_call do turno (Bloco 7). Usada pelo hook `transfer-trigger`
   * no ramo (b) — `classify_lead` com classification='HOT' + lead com 3 dados
   * obrigatórios também dispara handoff. Setado pelo loop após cada dispatch.
   */
  lastToolCall?: {
    name: string;
    input: unknown;
    result: ToolResult<unknown>;
  };

  /**
   * Texto cru retornado pelo LLM no turno (preenchido pelo loop após callLLM).
   * `format-whatsapp` (AFTER_MODEL) substitui in-place pela versão formatada
   * para o WhatsApp; `human-delay` e `response-guard` consomem.
   */
  lastModelText?: string;

  /**
   * Bloco 2 — feature `whatsapp-message-splitting-and-handoff-continuity`.
   *
   * Output do splitter no `format-whatsapp` (AFTER_MODEL). Quando ausente ou
   * length=1, o pipeline runner mantém comportamento legacy (1 send via
   * `lastModelText`). Quando length>1, o runner itera BEFORE_SEND N vezes,
   * uma por parte, com delay configurável (`message_split.interval_ms`)
   * entre cada send.
   *
   * Cada parte é validada pelo `response-guard` (incluindo guard de
   * `turn.id` corrente — Bloco 2 task #11) antes do send.
   */
  messages?: string[];

  /**
   * Bloco 2 — índice da parte corrente quando o pipeline runner está iterando
   * sobre `messages[]`. Setado pelo loop antes de cada iteração de BEFORE_SEND.
   * Usado pelo `human-delay` (typing indicator) e pelo `response-guard` (logs).
   * `partTotal` espelha `messages.length` na iteração.
   */
  partIndex?: number;
  partTotal?: number;

  /**
   * Bloco 2 — texto da parte corrente sendo enviada. Quando `messages.length>1`,
   * o pipeline runner copia `messages[partIndex]` para cá antes de cada
   * BEFORE_SEND. `responseToSend` continua sendo o texto unificado para
   * persistência inicial em `messages` (única row outbound, registro do turno).
   */
  currentMessage?: string;

  /**
   * Resposta a enviar no fim do pipeline. Caminhos:
   *   - happy path: igual a `lastModelText` (após format-whatsapp).
   *   - short-circuit em BEFORE_REQUEST com `response`: setado pelo loop antes
   *     de seguir, mas como o turno é cortado, o envio fica para o Bloco 9
   *     (canal próprio do admin/rate-limit — fora do pipeline normal).
   */
  responseToSend?: string;

  eventBus: EventBus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultado do loop
// ─────────────────────────────────────────────────────────────────────────────

export type LoopStatus =
  | 'completed'
  | 'duplicate_skipped'
  | 'agent_inactive'
  | 'short_circuit'
  | 'error';

export interface LoopResult {
  status: LoopStatus;
  turnId: TurnId;
  /** Mensagem inbound persistida (uuid messages.id) — pode coincidir com turnId. */
  inboundMessageId?: string;
  /** Outbound criada (se chegou a essa etapa). */
  outboundMessageId?: string;
  /** Razão para estados não-`completed`. */
  reason?: string;
}
