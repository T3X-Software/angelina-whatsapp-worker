// src/harness/loop.ts
//
// Bloco 5 — Tasks 29 + 30.
//
// HarnessLoop orquestrador. 15 etapas com hooks/tools/LLM mockados.
// Cada `loop.run(payload, headers)` cria uma nova instância de EventBus
// (per-turn, NÃO global) e roda o pipeline:
//
//   1. turnId placeholder = randomUUID()
//   2. phone = normalizeE164(payload.data.sender.id)
//   3. {contactId} = resolveContactFromPhone(phone)            (Bloco 4)
//   4. leadId = resolveActiveLead(contactId)                   (Bloco 4)
//   5. {messageId, isDuplicate} = claimMessage(...)            (Task 28)
//        → se duplicate: emit duplicate_skipped, flush, return
//   6. createEventBus(turnId, contactId, leadId)
//      → bindMessageId(messageId) — turn_id passa a ser messageId
//   7. (mesma — bind feito no passo 6)
//   8. config = findActiveByKey('angelina')                    (cache 30s — Bloco 11)
//        → se NULL: emit agent_inactive, flush, return
//   9. Monta HarnessContext
//  10. Hooks BEFORE_REQUEST (mocks ordem rate-limit, admin, load-context)
//        → se algum shortCircuit: short_circuit return
//  11. Compose memory (STUB)
//  12. Call LLM (STUB) — `{ text:'mock response', toolCalls:[] }`
//  13. Hooks AFTER_MODEL (mocks ordem transfer-trigger, format-whatsapp)
//  14. INSERT outbound (`pending`)                             (Task 28 do brief)
//  15. Hooks BEFORE_SEND (mocks ordem human-delay, response-guard)
//  16. State machine atômica `pending→sent` (mock send — UPDATE direto)
//  17. updateLastActivity(leadId)                              (Bloco 4)
//  18. emit turn_complete
//  19. flushToDatabase
//  20. return {status:'completed', ...}
//
// Erro top-level (Task 30): catch que emite `turn_error` (high), marca outbound
// `failed` se já existia, tenta flush (silencioso), retorna `{status:'error'}`.
//
// Cancellation: confiamos no `lockDuration: 60000` do Worker (Bloco 3).
// Se um turno demorar > 60s, BullMQ libera o lock — o turno em curso ainda
// pode terminar, mas outro worker poderá pegar o job. Idempotência de
// `claimMessage` previne dupla resposta.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import { messages } from '../db/schema';
import { findActiveByKey } from '../config/agent-configs';
import { resolveContactFromPhone, normalizeE164 } from '../contacts/resolveContact';
import { resolveActiveLeads, type ActiveLeadSnapshot } from '../contacts/resolveActiveLead';
import { updateLastActivity } from '../contacts/updateLastActivity';
import type { WebhookPayload } from '../edge/payload';

import pino from 'pino';

import { createEventBus } from './event-bus';
import { claimMessage } from './idempotency';
import { setCurrentTurn } from './turn-tracker';
import { buildHookPipeline } from '../hooks';
import { ZapsterClient } from '../zapster/client';
import { sendWithStateMachine } from '../zapster/sender';
import { getEnabledTools, getToolByName } from '../tools/registry';
import { callClaude } from '../llm/anthropic';
import {
  LLMUnavailableError,
  type LLMContentBlock,
  type LLMMessage,
  type LLMUsage,
} from '../llm/types';
import type {
  AnyTool,
  Hook,
  HarnessContext,
  HookPhase,
  LoopResult,
  ToolResult,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline real — composto uma vez por boot via factory de `src/hooks/index.ts`.
// ZapsterClient é STUB no Bloco 6 (decisão registrada no log) e vira o real
// no Bloco 9 sem mudar este arquivo (basta o construtor passar a fazer HTTP).
// ─────────────────────────────────────────────────────────────────────────────

const harnessLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Não usar pino-pretty aqui — o boot principal (`main.ts`) já é o lugar
  // de configurar o transport. Se este logger for usado em smokes, JSON puro
  // é mais facilmente parseável.
});

const zapsterClient = new ZapsterClient(harnessLogger);

const REAL_HOOKS: Record<HookPhase, ReadonlyArray<Hook>> =
  buildHookPipeline(zapsterClient);

// ─────────────────────────────────────────────────────────────────────────────
// Config loader (Bloco 11 — src/config/agent-configs.ts)
//
// O STUB inline foi removido: agora usamos `findActiveByKey` do módulo
// dedicado, que cacheia o resultado (inclusive `null`) por 30s.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// LLM STUB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forma de resposta do LLM por iteração. Quando vier `toolCalls.length>0`,
 * o loop executa cada uma e re-chama o LLM (até `max_iterations`).
 */
export interface MockLLMResponse {
  text: string;
  toolCalls: Array<{ name: string; input: unknown }>;
}

/**
 * Função "LLM mock" injetável. Recebe `(ctx, iteration, prevToolResults)`
 * e retorna a resposta da iteração `iteration` (0-indexada).
 *
 * Uso:
 *   - Em prod (Bloco 8), substituído por callClaude real (Anthropic SDK).
 *   - Em smokes (Bloco 7+), pode ser injetada via `RunOptions.mockLLM`
 *     para emular tool_use sequences específicas.
 */
export type MockLLMFn = (
  ctx: HarnessContext,
  iteration: number,
  prevToolResults: ReadonlyArray<{ name: string; result: ToolResult<unknown> }>,
) => Promise<MockLLMResponse>;

/**
 * Mock LLM utilitário — retorna texto fixo, sem tool calls.
 *
 * Mantido EXPORTADO no Bloco 8 para uso em smokes futuros que queiram exercitar
 * o orquestrador sem custo real. Em prod, o `defaultLLM` (callClaude real)
 * é o usado por `run()`.
 */
export const defaultMockLLM: MockLLMFn = async (ctx) => {
  ctx.eventBus.emit(
    'llm_request_mock',
    {
      model: ctx.config?.model ?? 'unknown',
      max_iterations: ctx.config?.maxIterations ?? 1,
      mock: true,
    },
    'info',
  );
  return {
    text: 'mock response',
    toolCalls: [],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Default LLM real (Bloco 8) — chama Claude via callClaude.
//
// Recebe (ctx, iteration, prevToolResults) — mesma assinatura do MockLLMFn —
// e monta as mensagens para o SDK:
//
//   1. Memória L1 (Bloco 10) — STUB no Bloco 5 ainda; quando ativada, vira
//      o histórico de mensagens user/assistant.
//   2. User turn atual (texto inbound do cliente) — só no iter=0.
//   3. Em iter>0: assistant turn anterior (com tool_use blocks) +
//      user turn (com tool_result blocks) — re-construído a partir do
//      histórico que o loop carrega em prevToolResults E lastToolCallsByIter.
//
// Decisão (Bloco 8): como o LOOP atual chama llmFn iter por iter sem manter
// o histórico de tool_use blocks emitidos pelo Claude, este wrapper precisa
// reconstruir a "pseudo-conversation" usando os tool calls que registramos.
// Mantemos `lastModelToolCalls` em closure (per-turn) para correlacionar.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-turn accumulator que mapeia iteration -> tool_use blocks emitidos.
 * Recriado por turno (escopo dentro do `run()`).
 *
 * Estrutura: array indexed by iteration, cada slot guarda { text, toolUses }.
 */
interface TurnLLMHistory {
  /** Texto + tool_use blocks emitidos pelo Claude na iteração `i`. */
  iterations: Array<{
    text: string;
    toolUses: Array<{ id: string; name: string; input: unknown }>;
  }>;
  /** Tokens/cost acumulados (somado em todas as iterações). */
  cumulative: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
  };
}

function newTurnHistory(): TurnLLMHistory {
  return {
    iterations: [],
    cumulative: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    },
  };
}

function accumulateUsage(
  history: TurnLLMHistory,
  usage: LLMUsage,
  costUsd: number,
): void {
  history.cumulative.inputTokens += usage.inputTokens;
  history.cumulative.outputTokens += usage.outputTokens;
  history.cumulative.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
  history.cumulative.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
  history.cumulative.costUsd += costUsd;
}

/**
 * Constrói o array de LLMMessage para a chamada Claude na iteração `iter`.
 *
 * - iter=0: [user(textoInbound)]
 * - iter>0: [user(textoInbound), assistant(text + tool_use[]), user(tool_result[]), ...]
 *
 * Tool results são serializados como JSON.stringify do `ToolResult` para que
 * o LLM enxergue success/error/data exatamente como nossa contract.
 */
function buildMessagesForIter(
  ctx: HarnessContext,
  history: TurnLLMHistory,
  prevToolResults: ReadonlyArray<{ name: string; result: ToolResult<unknown> }>,
  iter: number,
): LLMMessage[] {
  const out: LLMMessage[] = [];

  // L1 memory (Bloco 10): histórico + user turn atual já vem pronto do composer
  // dentro de `ctx.memory.l1` (LLMMessage[]). Se o hook não rodou (defensive),
  // fallback no path antigo (só user turn atual).
  const composed = ctx.memory?.l1 as LLMMessage[] | undefined;
  if (composed && composed.length > 0) {
    out.push(...composed);
  } else {
    out.push({
      role: 'user',
      content: ctx.message.text ?? '',
    });
  }

  // Re-emite o histórico de iterações ANTERIORES (assistant text + tool_use,
  // depois user tool_result). prevToolResults vem flat — precisamos casar com
  // os tool_uses que registramos por iteração para preservar tool_use_id.
  let prevIdx = 0;
  for (let i = 0; i < iter; i++) {
    const past = history.iterations[i];
    if (!past) continue;

    // Bloco assistant: text + tool_use[]
    const assistantBlocks: LLMContentBlock[] = [];
    if (past.text) {
      assistantBlocks.push({ type: 'text', text: past.text });
    }
    for (const tu of past.toolUses) {
      assistantBlocks.push({
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input,
      });
    }
    if (assistantBlocks.length > 0) {
      out.push({ role: 'assistant', content: assistantBlocks });
    }

    // Bloco user: tool_result[] (um por tool_use desta iteração).
    const userBlocks: LLMContentBlock[] = [];
    for (const tu of past.toolUses) {
      const r = prevToolResults[prevIdx];
      prevIdx++;
      const content = r ? JSON.stringify(r.result) : '{"success":false,"error":"missing_result"}';
      userBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content,
        is_error: r ? !r.result.success : true,
      });
    }
    if (userBlocks.length > 0) {
      out.push({ role: 'user', content: userBlocks });
    }
  }

  return out;
}

/**
 * Builds o `defaultLLM` real bound a um `TurnLLMHistory` per-turn (closure).
 * O loop chama `defaultLLMBuilder(history)(ctx, iter, prevToolResults)`.
 */
function buildDefaultLLM(history: TurnLLMHistory): MockLLMFn {
  return async (ctx, iteration, prevToolResults) => {
    if (ctx.config === null) {
      // Não deveria chegar aqui (loop checa antes), mas guarda defensiva.
      throw new LLMUnavailableError(
        'no agent config — defaultLLM cannot run',
        new Error('config is null'),
        'unknown',
      );
    }

    const enabled = getEnabledTools(ctx.config.toolsEnabled ?? []);
    const messages = buildMessagesForIter(ctx, history, prevToolResults, iteration);

    // System: prefere o pré-montado pelo composer (Bloco 10) — inclui L2 + ts.
    const systemPrompt = ctx.memory?.system ?? ctx.config.systemPrompt;

    const resp = await callClaude({
      systemPrompt,
      messages,
      tools: enabled,
      model: ctx.config.model,
      temperature: Number(ctx.config.temperature ?? 0.4),
      maxTokens: 4096,
      eventBus: ctx.eventBus,
      iteration,
    });

    // Persist usage cumulativo no history.
    // Cost calc duplicado aqui? Não — callClaude já calculou e emitiu trace
    // com `cost_usd`. Vamos refazer a soma fina via accumulateUsage usando o
    // valor calculado pelo callClaude, mas para evitar dupla import calculamos
    // aqui também (custo bem barato).
    const costUsd = pricingCost(resp.model, resp.usage);
    accumulateUsage(history, resp.usage, costUsd);

    // Registra a iteração no history (para reconstruir messages na próxima).
    history.iterations[iteration] = {
      text: resp.text,
      toolUses: resp.toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
    };

    return {
      text: resp.text,
      toolCalls: resp.toolCalls.map((c) => ({ name: c.name, input: c.input })),
    };
  };
}

// Helper local para evitar duplicar import de pricing aqui — calcula custo
// com base no usage retornado pelo callClaude.
import { calculateCost as pricingCalc } from '../llm/pricing';
function pricingCost(model: string, usage: LLMUsage): number {
  return pricingCalc(
    model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens ?? 0,
    usage.cacheCreationInputTokens ?? 0,
  );
}

/**
 * Persist tool call/result em messages.
 *
 * - direction='INBOUND' (semantica: o tool_result eh um "input" do mundo
 *   externo voltando para a IA — analogo ao webhook do cliente).
 * - role='tool' (Anthropic SDK convention para tool_result).
 * - tool_name, tool_args (jsonb), tool_result (jsonb).
 *
 * Decisao de schema (Bloco 7):
 *   O CHECK `messages_direction_send_consistency_chk` exige que
 *   direction='OUTBOUND' implique send_status NOT NULL. Tool calls/results
 *   sao registros de auditoria internos — NAO vao para o WhatsApp. Tres
 *   opcoes:
 *     (a) direction='OUTBOUND' + send_status='sent' — viola semantica
 *         (estaria afirmando que enviamos algo via Zapster).
 *     (b) direction='OUTBOUND' + send_status='pending' — eternamente
 *         "pending", confunde queries de outbound real.
 *     (c) direction='INBOUND' — o tool_result alimenta a proxima iteracao
 *         do LLM (analogo a uma resposta do mundo externo). CHECK respeitado
 *         (INBOUND exige send_status IS NULL — default).
 *   Escolhemos (c) — eh tambem o mais alinhado com o protocolo Anthropic
 *   (tool_result tem role 'user' do ponto de vista do LLM, mas role='tool'
 *   no SDK).
 *
 * Nao conta como mensagem que vai para o WhatsApp — eh um "evento interno"
 * do turno, persistido para auditoria.
 */
async function persistToolCall(
  ctx: HarnessContext,
  toolName: string,
  toolArgs: unknown,
  toolResult: ToolResult<unknown>,
  toolUseMessageId: string | null,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO messages (
        contact_id, lead_id, direction, role,
        tool_name, tool_args, tool_result, tool_use_message_id
      ) VALUES (
        ${ctx.contact.id},
        ${ctx.lead?.id ?? null},
        ${'INBOUND'}::message_direction,
        ${'tool'}::message_role,
        ${toolName},
        ${JSON.stringify(toolArgs)}::jsonb,
        ${JSON.stringify(toolResult)}::jsonb,
        ${toolUseMessageId}
      )
    `);
  } catch (err) {
    // Persist falhou — emit trace mas NAO derruba o turno (ja temos o
    // resultado da tool em memoria, podemos seguir).
    ctx.eventBus.emit(
      'tool_persist_failed',
      {
        tool_name: toolName,
        error: err instanceof Error ? err.message : String(err),
      },
      'med',
    );
  }
}

/**
 * Persist 1 row para o ASSISTANT tool_use emitido pelo LLM, ANTES da tool
 * executar. Sergio aprovou abordagem I (Bloco 6.5, fix bug #5 do L1 composer):
 * persistir explicitamente em vez de reconstruir no L1 — auditável.
 *
 * Esquema:
 *   - direction='INBOUND' (mesmo padrão do tool_result — auditoria interna,
 *     não vai pro WhatsApp; respeita CHECK `messages_direction_send_consistency_chk`).
 *   - role='assistant' tool_name=X tool_args=Y text=NULL.
 *   - tool_use_message_id NULL nesta row (ela mesma é o tool_use; o pareamento
 *     é feito pelo `persistToolCall` subsequente, que grava esta row.id em
 *     `tool_use_message_id` da row tool_result).
 *
 * Sem assistant tool_use no histórico, a Anthropic devolve HTTP 400 ao tentar
 * usar o tool_result em iter>0 ou em turnos subsequentes via L1. Bug capturado
 * em smoke local 2026-05-03 ("Festa de casamento" → fallback técnico).
 *
 * Retorna o `id` da row inserida — usado pelo `persistToolCall` em seguida
 * como `toolUseMessageId` para parear o tool_result.
 *
 * Em caso de falha de persist, retorna `null` (continuamos o turno; trace
 * `assistant_tool_use_persist_failed` emitido). O pareamento no L1 fica
 * NULL e cai no fallback do mapping (deriva tool_use_id do próprio row.id —
 * funciona em iterações dentro do mesmo turno, mas pode quebrar L1 cross-turn).
 */
async function persistAssistantToolUse(
  ctx: HarnessContext,
  toolName: string,
  toolArgs: unknown,
): Promise<string | null> {
  try {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO messages (
        contact_id, lead_id, direction, role,
        tool_name, tool_args
      ) VALUES (
        ${ctx.contact.id},
        ${ctx.lead?.id ?? null},
        ${'INBOUND'}::message_direction,
        ${'assistant'}::message_role,
        ${toolName},
        ${JSON.stringify(toolArgs)}::jsonb
      )
      RETURNING id::text AS id
    `);
    const row = Array.from(result)[0];
    return row?.id ?? null;
  } catch (err) {
    ctx.eventBus.emit(
      'assistant_tool_use_persist_failed',
      {
        tool_name: toolName,
        error: err instanceof Error ? err.message : String(err),
      },
      'med',
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook runner — invoca hooks da fase em ordem; respeita short-circuit
// ─────────────────────────────────────────────────────────────────────────────

interface HookRunResult {
  shortCircuited: boolean;
  response?: string;
  hookName?: string;
}

async function runPhase(
  phase: HookPhase,
  ctx: HarnessContext,
): Promise<HookRunResult> {
  const hooks = REAL_HOOKS[phase];
  for (const hook of hooks) {
    const result = await hook.run(ctx);
    if (result.contextUpdate) {
      // Aplicar patches mínimos — Bloco 6 vai usar mais a fundo.
      Object.assign(ctx, result.contextUpdate);
    }
    if (result.shortCircuit) {
      ctx.eventBus.emitHook(
        hook.name,
        phase,
        { short_circuited: true, response: result.response },
        'info',
      );
      return {
        shortCircuited: true,
        response: result.response,
        hookName: hook.name,
      };
    }
  }
  return { shortCircuited: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send real (Bloco 9) — delegado para `sendWithStateMachine` em
// `src/zapster/sender.ts`, que encapsula a state machine atômica
// (concept `outbound-state-machine`) e o `ZapsterClient` REAL com retry.
//
// Mantemos esta seção apenas como ponto de documentação — o helper inline
// `mockSendOutbound` do Bloco 5 foi REMOVIDO. Hooks `transfer-trigger` e
// `human-delay` continuam chamando `client.send()` direto (invariante 5).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// run() — entrada pública chamada pelo consumer (Bloco 3 #18)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /**
   * Substitui o LLM padrão (mock fixo) por uma função custom — útil para
   * smokes que precisam emular tool_use sequences específicas (Bloco 7).
   * Em prod (Bloco 8), o `callClaude` real é injetado aqui.
   */
  mockLLM?: MockLLMFn;
}

export async function run(
  payload: WebhookPayload,
  headers: Record<string, string | undefined>,
  options: RunOptions = {},
): Promise<LoopResult> {
  // [1] turnId placeholder até termos messageId.
  let turnId: string = randomUUID();
  // contactId/leadId/messageId/outboundId resolvidos ao longo do fluxo.
  let contactId: string | null = null;
  let leadId: string | null = null;
  let messageId: string | null = null;
  let outboundId: string | null = null;
  // EventBus criado depois do `claimMessage` (precisamos do contactId/leadId).
  // Para erros muito cedo (parse / resolveContact), criamos um bus fallback.
  let bus: ReturnType<typeof createEventBus> | null = null;

  try {
    // [2] phone normalizado.
    const phone = normalizeE164(payload.data.sender.id);

    // [3] contact (auto-cria se inédito).
    const contact = await resolveContactFromPhone(phone);
    contactId = contact.contactId;

    // [4] lead ativo. Pode haver 0, 1 ou 2+ leads OPEN para o contato.
    //   - 0  → leadId=null, sem ambiguidade (caminho original).
    //   - 1  → leadId=lead.id, sem ambiguidade (caminho original).
    //   - 2+ → leadId=null, ambíguo: composer pede desambiguação ao cliente
    //          via `## Leads ativos do contato (atendimento ambíguo)`. A
    //          mensagem inbound deste turno fica com `lead_id=null`
    //          (`messages.lead_id` é nullable; L1 filtra por contact_id).
    const activeLeads = await resolveActiveLeads(contactId);
    let leadCandidates: HarnessContext['leadCandidates'];
    if (activeLeads.length === 1) {
      leadId = activeLeads[0].id;
      leadCandidates = undefined;
    } else if (activeLeads.length >= 2) {
      leadId = null;
      leadCandidates = activeLeads.map((l) => ({
        id: l.id,
        classification: l.classification,
        eventType: l.eventType,
        eventDate: l.eventDate,
        guestCount: l.guestCount,
        lastActivityAt: l.lastActivityAt,
      }));
    } else {
      leadId = null;
      leadCandidates = undefined;
    }

    // [5] claimMessage.
    const claim = await claimMessage(payload, contactId, leadId);
    messageId = claim.messageId;

    // [6] EventBus per-turn.
    bus = createEventBus(turnId, contactId, leadId);
    bus.bindMessageId(messageId);

    // [7] turnId passa a ser o messageId (decisão brief #29).
    turnId = messageId;

    // Bloco 2 (feature whatsapp-message-splitting-and-handoff-continuity, #10):
    // marca este turnId como o turno corrente do contato. Usado pelo
    // response-guard (em iterações de split) para descartar partes stale
    // quando o cliente envia uma nova mensagem entre o split-N e split-N+1.
    setCurrentTurn(contactId, turnId);

    // Trace inicial — útil para correlacionar com logs do consumer.
    bus.emit(
      'webhook_received',
      {
        zapster_message_id: payload.data.message.id,
        message_type: payload.data.message.type,
        recipient_type: payload.data.recipient.type,
        contact_is_new: contact.isNew,
        has_lead: leadId !== null,
      },
      'info',
    );

    // Duplicate-skipped: emit + flush + return.
    if (claim.isDuplicate) {
      bus.emit(
        'duplicate_skipped',
        {
          zapster_message_id: payload.data.message.id,
          existing_inbound_id: messageId,
        },
        'info',
      );
      await bus.flushToDatabase();
      return {
        status: 'duplicate_skipped',
        turnId,
        inboundMessageId: messageId,
        reason: 'zapster_message_id already present',
      };
    }

    // [8] Carrega config (cache 30s — Bloco 11).
    const config = await findActiveByKey('angelina');
    if (config === null) {
      bus.emit(
        'agent_inactive',
        { reason: 'agent_configs.angelina has no is_active=true row' },
        'info',
      );
      await bus.flushToDatabase();
      return {
        status: 'agent_inactive',
        turnId,
        inboundMessageId: messageId,
        reason: 'agent inactive (feature flag off)',
      };
    }

    // [9] HarnessContext.
    // Quando há 1 lead ativo, reaproveitamos o snapshot já carregado em
    // `activeLeads[0]` (evita SELECT redundante). Quando ambíguo (2+) ou
    // sem leads, `leadSnapshot` fica null.
    const leadSnapshot: ActiveLeadSnapshot | null =
      leadId !== null ? (activeLeads[0] ?? null) : null;

    const ctx: HarnessContext = {
      turn: { id: turnId, startedAt: Date.now() },
      contact: {
        id: contactId,
        phone,
        name: contact.name,
        // STUB: para o smoke do Bloco 5, lemos o estado direto do contato
        // criado/encontrado. Bloco 6 (response-guard) vai re-ler isso na hora
        // do envio (não cachear).
        aiState: 'AUTO',
      },
      lead: leadId
        ? {
            id: leadId,
            isHumanActive: leadSnapshot?.isHumanActive ?? false,
            classification: leadSnapshot?.classification ?? null,
            eventType: leadSnapshot?.eventType ?? null,
            eventDate: leadSnapshot?.eventDate ?? null,
            guestCount: leadSnapshot?.guestCount ?? null,
            estimatedBudget: leadSnapshot?.estimatedBudget ?? null,
            preferences: leadSnapshot?.preferences ?? null,
            notes: leadSnapshot?.notes ?? null,
            visitScheduledAt: leadSnapshot?.visitScheduledAt ?? null,
          }
        : null,
      leadCandidates,
      message: {
        inboundId: messageId,
        zapsterMessageId: payload.data.message.id,
        text: payload.data.message.text,
        type: payload.data.message.type,
      },
      config,
      payload,
      headers,
      eventBus: bus,
    };

    // [10] Hooks BEFORE_REQUEST.
    const beforeReq = await runPhase('BEFORE_REQUEST', ctx);
    if (beforeReq.shortCircuited) {
      // Hooks BEFORE_REQUEST que retornam `response` (admin-router,
      // rate-limit-guard) populam `ctx.responseToSend` e a resposta é
      // enviada DIRETO via Zapster (canal meta/admin — bypassa response-guard
      // de modo análogo a `transfer-trigger`, invariante 5). Não persistimos
      // como OUTBOUND: a confirmação de admin não é parte da conversa do
      // cliente para fins de histórico/L1.
      if (beforeReq.response) {
        ctx.responseToSend = beforeReq.response;
      }
      if (ctx.responseToSend) {
        try {
          await zapsterClient.send({
            recipientId: payload.data.sender.id,
            recipientType: payload.data.recipient.type,
            text: ctx.responseToSend,
          });
          bus.emit(
            'admin_response_sent',
            {
              hook: beforeReq.hookName,
              chars: ctx.responseToSend.length,
            },
            'info',
          );
        } catch (err) {
          bus.emit(
            'admin_response_send_failed',
            {
              hook: beforeReq.hookName,
              err: err instanceof Error ? err.message : String(err),
            },
            'high',
          );
        }
      }
      bus.emit(
        'turn_short_circuit',
        {
          phase: 'BEFORE_REQUEST',
          hook: beforeReq.hookName,
          has_response: ctx.responseToSend !== undefined,
        },
        'info',
      );
      await bus.flushToDatabase();
      return {
        status: 'short_circuit',
        turnId,
        inboundMessageId: messageId,
        reason: `short-circuit at BEFORE_REQUEST/${beforeReq.hookName}`,
      };
    }

    // [11] Compose memory — Bloco 10: o hook `load-context-and-summary`
    // (último de BEFORE_REQUEST) já populou `ctx.memory` com L1+L2+system.
    // Defensive: se por algum motivo o hook não rodou (path edge), garante
    // shape mínimo para o LLM call não quebrar.
    if (!ctx.memory) {
      ctx.memory = { l1: [], l2: '' };
      bus.emit('memory_missing_after_hooks', { fallback: true }, 'med');
    }

    // [11.5] Interceptação de áudio (e outras mídias) — Bloco 12 #63 / Q14.
    //
    // Decisão de produto: a Angelina v1 NÃO transcreve áudio (Whisper fica
    // para `harness-audio-transcribe`). Resposta fixa pede pra mandar por texto.
    // Tudo que não é texto (audio, image, video, document, sticker, etc.) cai
    // aqui — `media_url`/`media_type` já foram gravados em `claimMessage`.
    //
    // Comportamento:
    //   - PULA LLM call e tools (custo $0).
    //   - Seta finalText = mensagem fixa.
    //   - Segue AFTER_MODEL/BEFORE_SEND normalmente (response-guard valida).
    //   - Emit trace `audio_inbound_fixed_response`.
    //
    // Usado também para outras mídias — texto da resposta é o mesmo.
    let interceptedFixedResponse = false;
    if (payload.data.message.type !== 'text') {
      bus.emit(
        'audio_inbound_fixed_response',
        {
          message_type: payload.data.message.type,
          has_media_url: payload.data.message.media?.url !== undefined,
        },
        'info',
      );
      interceptedFixedResponse = true;
    }

    // [12] Call LLM + tool dispatch loop (Bloco 7).
    //
    // Loop de iterações limitado por `agent_configs.max_iterations` (default 5).
    // A cada iteração:
    //   1. Chama o LLM (mock no Bloco 7 — Claude real no Bloco 8).
    //   2. Se response tem `toolCalls`, dispatch cada uma:
    //        - lookup via getToolByName
    //        - validar contra tools_enabled (segurança)
    //        - tool.execute(input, ctx) → ToolResult
    //        - se ToolResult.data.trigger_handoff===true → seta
    //          ctx.handoffRequested
    //        - persist em messages (tool_name/args/result)
    //        - acumula em prevToolResults para próxima iteração
    //   3. Se response NÃO tem toolCalls → texto final, sai do loop.
    //   4. Se atingiu maxIter → para mesmo se LLM ainda quer chamar tools.
    // History per-turn — usado pelo defaultLLM real para reconstruir
    // a "conversation" entre iterações (assistant tool_use -> user tool_result).
    // Mocks não usam, mas o accumulator de custos ainda alimenta o INSERT
    // outbound (mocks nunca incrementam pois não passam por accumulateUsage).
    const llmHistory = newTurnHistory();
    const llmFn = options.mockLLM ?? buildDefaultLLM(llmHistory);
    const enabledTools = getEnabledTools(ctx.config?.toolsEnabled ?? []);
    const enabledNames = new Set(enabledTools.map((t) => t.name));
    const maxIter = ctx.config?.maxIterations ?? 1;

    const prevToolResults: Array<{
      name: string;
      result: ToolResult<unknown>;
    }> = [];
    let finalText = '';
    /** Indica que o turno usou o caminho de fallback (sem LLM real). */
    let usedFallback = false;

    // Interceptação de áudio/mídia (passo [11.5]): pula LLM call e tools.
    if (interceptedFixedResponse) {
      finalText =
        'Ah, te peço para mandar por texto, prometo te responder rapidinho 💌';
    }

    for (let iter = 0; iter < maxIter && !interceptedFixedResponse; iter++) {
      let llmResp: MockLLMResponse;
      try {
        llmResp = await llmFn(ctx, iter, prevToolResults);
      } catch (err) {
        if (err instanceof LLMUnavailableError) {
          // ─── Fallback path (Bloco 8 — task 47) ─────────────────────────
          // Emitir trace high, popular ctx.lastModelText com fallback_message,
          // PULAR tools (não há toolCalls), seguir para AFTER_MODEL.
          bus.emit(
            'llm_fallback_active',
            {
              model: err.model,
              error: err.message,
              iteration: iter,
            },
            'high',
          );
          finalText =
            ctx.config?.fallbackMessage ??
            'Desculpe, estou com instabilidade técnica agora. Já chamei a equipe humana.';
          usedFallback = true;
          break;
        }
        throw err; // outras exceções (programador, DB) sobem para top-level.
      }
      bus.emit(
        'llm_request_end_mock',
        {
          iteration: iter,
          text_len: llmResp.text.length,
          tool_calls: llmResp.toolCalls.length,
          mock: options.mockLLM !== undefined,
        },
        'info',
      );

      if (llmResp.toolCalls.length === 0) {
        // Resposta final — texto vai pro cliente.
        finalText = llmResp.text;
        break;
      }

      // Dispatch tools.
      for (const call of llmResp.toolCalls) {
        bus.emit(
          'tool_call_started',
          { tool_name: call.name, iteration: iter },
          'info',
        );

        // Persist ASSISTANT tool_use ANTES de executar a tool — pareamento
        // explícito tool_use ↔ tool_result para o L1 composer (bug #5 fix).
        const assistantToolUseId = await persistAssistantToolUse(
          ctx,
          call.name,
          call.input,
        );

        const t0 = performance.now();
        let toolResult: ToolResult<unknown>;

        if (!enabledNames.has(call.name)) {
          // Tool não habilitada na config — retorna erro ao LLM (não throw).
          toolResult = {
            success: false,
            error: `tool_not_enabled: ${call.name}`,
          };
        } else {
          const tool: AnyTool | undefined = getToolByName(call.name);
          if (tool === undefined) {
            toolResult = {
              success: false,
              error: `tool_not_found: ${call.name}`,
            };
          } else {
            // Valida input via Zod do próprio Tool.
            const parsed = tool.inputSchema.safeParse(call.input);
            if (!parsed.success) {
              toolResult = {
                success: false,
                error: `tool_input_invalid: ${parsed.error.issues
                  .map((i) => `${i.path.join('.')}: ${i.message}`)
                  .join('; ')}`,
              };
            } else {
              try {
                toolResult = await tool.execute(parsed.data, ctx);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                toolResult = {
                  success: false,
                  error: `tool_execute_threw: ${msg}`,
                };
                bus.emit(
                  'tool_call_failed',
                  { tool_name: call.name, error: msg },
                  'med',
                );
              }
            }
          }
        }

        const latencyMs = Math.round(performance.now() - t0);
        bus.emit(
          'tool_call_completed',
          {
            tool_name: call.name,
            iteration: iter,
            success: toolResult.success,
            latency_ms: latencyMs,
          },
          'info',
        );

        // Sinal de handoff: lemos do ToolResult.data.trigger_handoff.
        // Substitui o override de teste do Bloco 6.
        const data = toolResult.data as
          | { trigger_handoff?: boolean }
          | null
          | undefined;
        if (data?.trigger_handoff === true) {
          ctx.handoffRequested = true;
        }

        // Persiste tool_result em messages (auditoria) com FK para o tool_use.
        await persistToolCall(
          ctx,
          call.name,
          call.input,
          toolResult,
          assistantToolUseId,
        );

        // Atualiza ctx.lastToolCall para o ramo (b) do transfer-trigger.
        ctx.lastToolCall = {
          name: call.name,
          input: call.input,
          result: toolResult,
        };

        prevToolResults.push({ name: call.name, result: toolResult });
      }

      // Se chegamos no limite, sai sem chamar LLM de novo.
      if (iter === maxIter - 1) {
        bus.emit(
          'tool_loop_max_iterations_reached',
          { max_iterations: maxIter },
          'med',
        );
      }
    }

    // Popula `ctx.lastModelText` para os hooks AFTER_MODEL (`format-whatsapp`
    // substitui in-place pela versão WhatsApp; `transfer-trigger` ignora).
    ctx.lastModelText = finalText;

    // Defensive: se o loop NÃO populou `ctx.lastToolCall` (caminho fallback ou
    // áudio interceptado, em que LLM não roda), busca em `messages` o último
    // tool call do contato (≤24h). Necessário para o ramo (b) do transfer-trigger
    // detectar handoff baseado em `classify_lead` HOT pré-existente.
    if (!ctx.lastToolCall && contactId) {
      const tcRows = await db.execute<{
        tool_name: string;
        tool_args: unknown;
        tool_result: unknown;
      }>(sql`
        SELECT tool_name, tool_args, tool_result
          FROM messages
         WHERE contact_id = ${contactId}
           AND role = 'tool'
           AND tool_name IS NOT NULL
           AND created_at > now() - interval '24 hours'
         ORDER BY created_at DESC
         LIMIT 1
      `);
      const tc = Array.from(tcRows)[0];
      if (tc) {
        ctx.lastToolCall = {
          name: tc.tool_name,
          input: tc.tool_args,
          result: tc.tool_result as ToolResult<unknown>,
        };
        bus.emit(
          'last_tool_call_loaded_from_history',
          { tool_name: tc.tool_name },
          'info',
        );
      }
    }

    // [13] Hooks AFTER_MODEL.
    const afterModel = await runPhase('AFTER_MODEL', ctx);
    if (afterModel.shortCircuited) {
      bus.emit(
        'turn_short_circuit',
        { phase: 'AFTER_MODEL', hook: afterModel.hookName },
        'info',
      );
      await bus.flushToDatabase();
      return {
        status: 'short_circuit',
        turnId,
        inboundMessageId: messageId,
        reason: `short-circuit at AFTER_MODEL/${afterModel.hookName}`,
      };
    }

    // [14] INSERT outbound (pending).
    // CHECK_1 exige direction='OUTBOUND' → send_status NOT NULL: setamos 'pending'.
    // Texto: usa `ctx.lastModelText` (já formatado por `format-whatsapp`),
    // ou string vazia (caso loop tenha terminado sem texto final — raro,
    // pode acontecer se LLM atingir maxIter chamando só tools).
    //
    // Tokens/cost (Bloco 8): vêm do `llmHistory.cumulative` (defaultLLM real).
    // Em fallback (LLMUnavailableError), `usedFallback=true` força tokens=NULL
    // para distinguir nos relatórios.
    const outboundText = ctx.lastModelText ?? finalText ?? '';
    ctx.responseToSend = outboundText;
    const tokensIn = usedFallback || llmHistory.cumulative.inputTokens === 0
      ? null
      : llmHistory.cumulative.inputTokens +
        llmHistory.cumulative.cacheReadInputTokens +
        llmHistory.cumulative.cacheCreationInputTokens;
    const tokensOut = usedFallback || llmHistory.cumulative.outputTokens === 0
      ? null
      : llmHistory.cumulative.outputTokens;
    const costUsd = usedFallback || llmHistory.cumulative.costUsd === 0
      ? null
      : llmHistory.cumulative.costUsd.toFixed(6);
    const [outbound] = await db
      .insert(messages)
      .values({
        contactId,
        leadId,
        direction: 'OUTBOUND',
        role: 'assistant',
        text: outboundText,
        recipientId: ctx.contact.phone,
        recipientType: payload.data.recipient.type,
        sendStatus: 'pending',
        tokensIn,
        tokensOut,
        costUsd,
      })
      .returning({ id: messages.id });
    outboundId = outbound.id;
    bus.emit(
      'outbound_inserted',
      {
        outbound_id: outboundId,
        text_len: outboundText.length,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        used_fallback: usedFallback,
      },
      'info',
    );

    // [15] Hooks BEFORE_SEND + send.
    //
    // Bloco 2 (feature whatsapp-message-splitting-and-handoff-continuity):
    // quando o splitter (`format-whatsapp`) populou `ctx.messages` com >1 parte,
    // iteramos BEFORE_SEND + send N vezes (1 por parte) com delay configurável
    // (`message_split.interval_ms`) entre os sends. Quando length<=1, fluxo
    // legacy preservado: 1 BEFORE_SEND + 1 send.
    //
    // Decisão (sub-T2.3 do Bloco 2): só ramifica se messages.length > 1; caso
    // contrário, mantém path original sem overhead.
    //
    // Persistência: o INSERT outbound em [14] foi 1 row com texto UNIFICADO
    // (concat das partes em \n\n) — registro único do turno. Os sends das
    // partes individuais não criam rows extras em `messages` (auditoria via
    // traces `zapster_send_dispatch`/`zapster_send_success` por parte).
    // Parte 1: sendWithStateMachine (pending→sent, anti-double-send entre workers).
    // Partes 2-N: zapsterClient.send() direto (row já está em 'sent', bypass do guard).
    const splitParts = ctx.messages ?? [];
    const useSplit = splitParts.length > 1;

    if (useSplit) {
      const splitParams = (ctx.config?.hookParams ?? {}) as
        | { message_split?: { interval_ms?: number } }
        | undefined;
      const intervalMs = splitParams?.message_split?.interval_ms ?? 1500;
      ctx.partTotal = splitParts.length;

      bus.emit(
        'split_send_start',
        {
          parts: splitParts.length,
          interval_ms: intervalMs,
          outbound_id: outboundId,
        },
        'info',
      );

      let partsSent = 0;
      for (let i = 0; i < splitParts.length; i++) {
        ctx.partIndex = i;
        ctx.currentMessage = splitParts[i];
        // `responseToSend` é re-apontado por parte para que human-delay e
        // response-guard avaliem cada parte (delay proporcional, classifier
        // correto, etc.). Essa mutação é segura: ambos hooks leem ctx fresh
        // no início de cada `runPhase`.
        ctx.responseToSend = splitParts[i];

        const partPhase = await runPhase('BEFORE_SEND', ctx);
        if (partPhase.shortCircuited) {
          bus.emit(
            'turn_short_circuit',
            {
              phase: 'BEFORE_SEND',
              hook: partPhase.hookName,
              part_index: i,
              part_total: splitParts.length,
              reason: 'split_part_blocked',
            },
            'info',
          );
          // Se a 1ª parte foi bloqueada, marca outbound como failed (nada saiu).
          // Se já enviamos parte ≥1, mantém status atual ('sent') — auditoria
          // mostra que partes [i..N) não foram enviadas via traces.
          if (partsSent === 0) {
            await db.execute(sql`
              UPDATE messages SET send_status = 'failed'
               WHERE id = ${outboundId} AND send_status = 'pending'
            `);
            await bus.flushToDatabase();
            return {
              status: 'short_circuit',
              turnId,
              inboundMessageId: messageId,
              outboundMessageId: outboundId,
              reason: `short-circuit at BEFORE_SEND/${partPhase.hookName} (part ${i}/${splitParts.length})`,
            };
          }
          // Parte intermediária bloqueada (ex: stale_turn): para o loop e
          // sai do split — turno encerra normalmente, partes restantes
          // descartadas.
          bus.emit(
            'split_send_aborted',
            {
              part_index: i,
              part_total: splitParts.length,
              parts_sent: partsSent,
              hook: partPhase.hookName,
            },
            'med',
          );
          break;
        }

        let sendOk = true;
        let zapsterMessageId: string | undefined;

        if (i === 0) {
          // 1ª parte: state machine cuida de pending → sending → sent (anti-double-send entre workers).
          const result = await sendWithStateMachine(
            outboundId,
            zapsterClient,
            {
              recipientId: ctx.contact.phone,
              recipientType: payload.data.recipient.type,
              text: ctx.responseToSend,
            },
            bus,
          );
          sendOk = result.status === 'sent';
          zapsterMessageId = result.zapsterMessageId;
        } else {
          // Partes 2-N: bypass do state machine (row já está em 'sent' pela parte 1).
          // Pattern já existente em transfer-trigger e human-delay (chamadas diretas).
          bus.emit(
            'zapster_send_dispatch',
            { outbound_id: outboundId, part_index: i },
            'info',
          );
          try {
            const r = await zapsterClient.send({
              recipientId: ctx.contact.phone,
              recipientType: payload.data.recipient.type,
              text: ctx.responseToSend,
            });
            bus.emit(
              'zapster_send_success',
              {
                outbound_id: outboundId,
                part_index: i,
                zapster_message_id: r.zapsterMessageId,
              },
              'info',
            );
            zapsterMessageId = r.zapsterMessageId;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            bus.emit(
              'zapster_send_failure',
              { outbound_id: outboundId, part_index: i, error: errMsg },
              'high',
            );
            sendOk = false;
          }
        }

        if (!sendOk) {
          bus.emit(
            'split_send_aborted',
            {
              part_index: i,
              part_total: splitParts.length,
              parts_sent: partsSent,
              reason: 'send_failed',
            },
            'med',
          );
          break; // não envia partes restantes para preservar coerência
        }
        partsSent++;

        bus.emit(
          'split_part_sent',
          {
            part_index: i,
            part_total: splitParts.length,
            chars: ctx.responseToSend.length,
          },
          'info',
        );

        // Delay entre partes (não após a última).
        if (i < splitParts.length - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        }
      }

      // Limpa flags do split antes de seguir para [17].
      ctx.partIndex = undefined;
      ctx.partTotal = undefined;
      ctx.currentMessage = undefined;

      bus.emit(
        'split_send_complete',
        { parts_sent: partsSent, parts_total: splitParts.length },
        'info',
      );
    } else {
      // Path legacy — 1 BEFORE_SEND + 1 send.
      const beforeSend = await runPhase('BEFORE_SEND', ctx);
      if (beforeSend.shortCircuited) {
        bus.emit(
          'turn_short_circuit',
          { phase: 'BEFORE_SEND', hook: beforeSend.hookName },
          'info',
        );
        // Marca outbound como failed (response-guard bloqueou — não vai enviar).
        await db.execute(sql`
          UPDATE messages SET send_status = 'failed'
           WHERE id = ${outboundId} AND send_status = 'pending'
        `);
        await bus.flushToDatabase();
        return {
          status: 'short_circuit',
          turnId,
          inboundMessageId: messageId,
          outboundMessageId: outboundId,
          reason: `short-circuit at BEFORE_SEND/${beforeSend.hookName}`,
        };
      }

      // [16] State machine atômica + Zapster send REAL (Bloco 9).
      //
      // Texto vai do `ctx.responseToSend` (já formatado por format-whatsapp e
      // setado logo acima na etapa [14]). Recipient é o phone do cliente
      // (E.164 sem `+`, convenção do projeto consolidada no Bloco 4) com o
      // mesmo `recipient_type` (chat/group) que veio no payload.
      //
      // sendWithStateMachine retorna `sent | failed | race_lost` mas NÃO throwa
      // — falha é registrada no banco (send_status='failed') + trace
      // `zapster_send_failure` (high). Não interrompemos o restante do turno
      // (updateLastActivity, turn_complete) — race_lost também segue o fluxo.
      await sendWithStateMachine(
        outboundId,
        zapsterClient,
        {
          recipientId: ctx.contact.phone,
          recipientType: payload.data.recipient.type,
          text: outboundText,
        },
        bus,
      );
    }

    // [17] Atualiza last_activity_at do lead (se houver).
    if (leadId) {
      try {
        await updateLastActivity(leadId);
      } catch (err) {
        // Não derruba o turno — resposta já foi enviada.
        bus.emit(
          'update_last_activity_failed',
          { lead_id: leadId, error: err instanceof Error ? err.message : String(err) },
          'med',
        );
      }
    }

    // [18] Encerramento.
    const totalLatency = Math.round(performance.now() - ctx.turn.startedAt);
    bus.emit(
      'turn_complete',
      {
        turn_latency_ms: totalLatency,
        inbound_id: messageId,
        outbound_id: outboundId,
        // Bloco 5 — feature `rag-knowledge-population`. True quando o composer
        // anexou a seção `## Conhecimento relevante` neste turno. Útil para
        // SQL agg "% de turnos com RAG ativo". Defensive default false quando
        // memory ausente (path edge sem hook BEFORE_REQUEST).
        rag_active: ctx.memory?.ragActive ?? false,
      },
      'info',
    );

    // [19] Flush.
    await bus.flushToDatabase();

    // [20] Return.
    return {
      status: 'completed',
      turnId,
      inboundMessageId: messageId,
      outboundMessageId: outboundId,
    };
  } catch (err) {
    // ── Task 30 — erro top-level ──────────────────────────────────────────
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;

    // Se já temos bus, registra. Senão, cria um fallback minimo (raro: erro
    // antes do claimMessage; sem messageId, traces ficam órfãos mas ainda
    // úteis para debug).
    const fallbackBus =
      bus ??
      (contactId
        ? createEventBus(turnId, contactId, leadId)
        : null);

    if (fallbackBus) {
      fallbackBus.emit(
        'turn_error',
        { message, stack, has_outbound: outboundId !== null },
        'high',
      );
      // Se já criamos outbound, marca como failed.
      if (outboundId) {
        try {
          await db.execute(sql`
            UPDATE messages SET send_status = 'failed'
             WHERE id = ${outboundId} AND send_status IN ('pending','sending')
          `);
        } catch {
          // silent: já estamos no error path
        }
      }
      try {
        await fallbackBus.flushToDatabase();
      } catch {
        // silent
      }
    }

    return {
      status: 'error',
      turnId,
      inboundMessageId: messageId ?? undefined,
      outboundMessageId: outboundId ?? undefined,
      reason: message,
    };
  }
}
