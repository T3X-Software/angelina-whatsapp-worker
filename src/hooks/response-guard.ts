// src/hooks/response-guard.ts
//
// Bloco 6 — Task 38. ÚLTIMO hook de BEFORE_SEND (INVARIANTE 1).
//
// ⚠️ INVARIANTE 1 (CLAUDE.md raiz): "response-guard é sempre o último passo
// antes de qualquer envio. Nenhum código deve chamar zapsterClient.send() sem
// passar pelo response-guard."
//
// ⚠️ Re-leitura OBRIGATÓRIA: este hook NÃO usa `ctx.contact.aiState` nem
// `ctx.lead.isHumanActive` (cacheados no início do turno). Re-lê do banco
// porque admin-router pode ter alterado `ai_state` no meio do turno (admin
// digita `/pausar` enquanto a IA está processando — o turno em curso ainda
// pode bloquear a resposta antes do envio).
//
// Precedência (concept ai-state-control + Blocos 4 e 5 da feature
// `whatsapp-message-splitting-and-handoff-continuity` — modelo 3-estados):
//   0. stale_turn (Bloco 2)                       → descarta parte de turno antigo
//   1. contacts.ai_state = 'HUMAN_TAKEOVER'       → bloqueia tudo (máxima prioridade)
//   2. contacts.ai_state = 'PAUSED'               → bloqueia tudo
//   3a. is_human_active=true && assumed_at NOT NULL → bloqueia (humano confirmado)
//   3b. is_human_active=true && assumed_at IS NULL  → MODO ASSISTIDO TRANSITÓRIO
//                                                      → classifier avalia o texto:
//                                                        - duplicate_handoff → silencia (shortCircuit)
//                                                        - monetary/booking  → substitui por redirect
//                                                        - nenhum match      → libera passthrough
//                                                      emit `assisted_mode_redirect` (info) ou
//                                                            `assisted_mode_passthrough` (info)
//   4. caso contrário                              → IA responde normalmente
//
// ✅ Bloco 5 (this) — stage transitório FECHADO: classifier integrado ao
// caminho 3b. Patterns vêm de `agent_configs.hook_params.assisted_mode.classifier`
// (compilados com cache WeakMap em `assisted-mode-classifier.ts`). Quando
// match em monetary/booking, substitui `ctx.currentMessage` E
// `ctx.responseToSend` pelo redirect. Quando match em duplicate_handoff,
// silencia o envio (shortCircuit) — evita o cliente receber 2 anúncios
// consecutivos de "vou te transferir". Bloco 7 reforça via addendum no
// system_prompt; Bloco 6 via tool-gating.
//
// Quando bloqueia: emit `send_blocked` (severity 'info' — não é erro, é o
// guard fazendo o trabalho dele) com `{reason, ai_state, is_human_active,
// handoff_assumed_at_set}`, retorna `{shortCircuit: true}`. O loop.ts marca
// o outbound já criado como `failed` antes de retornar.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { Hook, HookResult, HarnessContext } from '../harness/types';
import { isCurrentTurn } from '../harness/turn-tracker';
import { classifyAssistedModeOutput } from './assisted-mode-classifier';
import type { HandoffContinuityHookParams } from '../config/types';

interface GuardRow {
  ai_state: string;
  is_human_active: boolean | null;
  /**
   * Bloco 4: lemos junto com is_human_active. Quando NULL → modo assistido
   * (3b libera). Quando NOT NULL → humano confirmou (3a bloqueia).
   * Drizzle retorna timestamps como `Date | string | null` dependendo do
   * driver; comparamos apenas com null.
   */
  handoff_assumed_at: Date | string | null;
  [key: string]: unknown;
}

export const responseGuard: Hook = {
  name: 'response-guard',
  phase: 'BEFORE_SEND',

  async run(ctx: HarnessContext): Promise<HookResult> {
    // Bloco 2 (feature whatsapp-message-splitting-and-handoff-continuity, #11):
    // guard de turno corrente. Quando o pipeline runner está iterando sobre
    // partes do split, novas mensagens inbound do cliente sobrescrevem o
    // `currentTurn` do contato em `turn-tracker`. Esta verificação descarta
    // partes stale (turno superado) ANTES das 3 regras de bloqueio existentes.
    //
    // Cenário típico: split em 4 partes. Cliente envia "espera, mudei de
    // ideia" entre split-2 e split-3. O novo turno faz `setCurrentTurn` com
    // novo turnId. Quando split-3 chegar aqui, isCurrentTurn retorna false →
    // emit `send_blocked` (reason='stale_turn') + shortCircuit.
    //
    // Para turnos sem split (path legacy), o guard sempre passa porque o
    // `setCurrentTurn(contactId, turnId)` no início do turno bate com `ctx.turn.id`.
    if (!isCurrentTurn(ctx.contact.id, ctx.turn.id)) {
      ctx.eventBus.emit(
        'send_blocked',
        {
          reason: 'stale_turn',
          contact_id: ctx.contact.id,
          turn_id: ctx.turn.id,
          part_index: ctx.partIndex,
          part_total: ctx.partTotal,
        },
        'info',
      );
      return { shortCircuit: true };
    }

    // Query única (single round-trip): contacts.ai_state +
    // leads.is_human_active + leads.handoff_assumed_at (LEFT JOIN para
    // tolerar contato sem lead — `COALESCE(false)` mantém o boolean NOT NULL;
    // `handoff_assumed_at` permanece NULL quando o contato não tem lead).
    //
    // Bloco 4: campo `handoff_assumed_at` adicionado ao SELECT. Define o
    // 3º estado de `is_human_active` (modo assistido vs handoff confirmado).
    const leadId = ctx.lead?.id ?? null;

    const rows = await db.execute<GuardRow>(sql`
      SELECT c.ai_state                                 AS ai_state,
             COALESCE(l.is_human_active, false)         AS is_human_active,
             l.handoff_assumed_at                       AS handoff_assumed_at
        FROM contacts c
        LEFT JOIN leads l ON l.id = ${leadId}
       WHERE c.id = ${ctx.contact.id}
       LIMIT 1
    `);
    const arr = Array.from(rows) as GuardRow[];
    if (arr.length === 0) {
      // Edge case extremo: contato deletado entre o início do turno e agora.
      // Bloqueia por segurança — sem destinatário válido, não enviamos nada.
      ctx.eventBus.emit(
        'send_blocked',
        {
          reason: 'contact_not_found',
          contact_id: ctx.contact.id,
        },
        'high',
      );
      return { shortCircuit: true };
    }

    const aiState = arr[0].ai_state;
    const isHumanActive = arr[0].is_human_active === true;
    // Bloco 4: NULL = modo assistido (3b libera); NOT NULL = humano confirmado (3a bloqueia).
    const handoffAssumedAt = arr[0].handoff_assumed_at;
    const assumedAtSet = handoffAssumedAt !== null && handoffAssumedAt !== undefined;

    // Regras 1, 2 e 3a (bloqueio).
    //
    // Precedência absoluta de `ai_state`: HUMAN_TAKEOVER e PAUSED bloqueiam
    // independente do estado do lead (preserva invariante #7 — `ai_state`
    // ≠ `is_human_active`). Smokes D e E cobrem isso.
    let reason: string | null = null;
    if (aiState === 'HUMAN_TAKEOVER') {
      reason = 'ai_state=HUMAN_TAKEOVER';
    } else if (aiState === 'PAUSED') {
      reason = 'ai_state=PAUSED';
    } else if (isHumanActive && assumedAtSet) {
      // 3a: humano já confirmou que assumiu o atendimento — IA muda 100%.
      // Reason renomeado para `is_human_active_assumed` (granularidade
      // adicional vs. v2 que usava `is_human_active=true`). Painel "Saúde
      // do agente" do CRM passará a distinguir 3a de 3b explicitamente.
      reason = 'is_human_active_assumed';
    }

    if (reason) {
      ctx.eventBus.emit(
        'send_blocked',
        {
          reason,
          ai_state: aiState,
          is_human_active: isHumanActive,
          handoff_assumed_at_set: assumedAtSet,
          contact_id: ctx.contact.id,
          lead_id: leadId,
        },
        'info',
      );
      return { shortCircuit: true };
    }

    // Regra 3b — modo assistido transitório (Blocos 4 + 5):
    // is_human_active=true && assumed_at IS NULL → avalia texto via
    // classifier. Match em monetary/booking → substitui por redirect; match
    // em duplicate_handoff → silencia (shortCircuit); nenhum match → libera
    // passthrough.
    //
    // Bloco 5: caminho do classifier integrado. Quando a config completa do
    // assisted_mode está presente (`classifier` + `redirect_messages`),
    // chamamos `classifyAssistedModeOutput`. Caso contrário (config faltando),
    // mantemos comportamento Bloco 4 (passthrough com `classifier_pending=true`).
    if (isHumanActive && !assumedAtSet) {
      const hookParams = (ctx.config?.hookParams ?? {}) as HandoffContinuityHookParams;
      const classifierConfig = hookParams.assisted_mode?.classifier;
      const redirects = hookParams.assisted_mode?.redirect_messages;
      const textToClassify =
        ctx.currentMessage ?? ctx.responseToSend ?? ctx.lastModelText ?? '';

      // Config completa: roda classifier.
      if (classifierConfig && redirects) {
        const result = classifyAssistedModeOutput(
          textToClassify,
          classifierConfig,
          redirects,
        );

        // duplicate_handoff: silencia. Evita cliente receber 2 anúncios
        // consecutivos de "vou te transferir" (a IA já está em transição).
        if (result.category === 'duplicate_handoff') {
          ctx.eventBus.emit(
            'assisted_mode_redirect',
            {
              contact_id: ctx.contact.id,
              lead_id: leadId,
              category: 'duplicate_handoff',
              silenced: true,
              part_index: ctx.partIndex,
              part_total: ctx.partTotal,
              original_text_preview: textToClassify.slice(0, 100),
            },
            'info',
          );
          // Bloqueia o envio (shortCircuit). Loop.ts marca outbound como
          // failed se for a 1ª parte; em parte intermediária, segue split.
          return { shortCircuit: true };
        }

        // monetary/booking: substitui por redirect. Mutação direta de AMBOS
        // `ctx.currentMessage` (path split) e `ctx.responseToSend` (path
        // legacy/sender) — pattern idêntico ao do loop.ts em [15] split,
        // garante que human-delay e o sender consumam o texto substituído.
        if (result.category && result.redirect) {
          ctx.eventBus.emit(
            'assisted_mode_redirect',
            {
              contact_id: ctx.contact.id,
              lead_id: leadId,
              category: result.category,
              silenced: false,
              part_index: ctx.partIndex,
              part_total: ctx.partTotal,
              original_text_preview: textToClassify.slice(0, 100),
              redirect_used: result.redirect.slice(0, 100),
            },
            'info',
          );
          ctx.currentMessage = result.redirect;
          ctx.responseToSend = result.redirect;
          // Continua para o trace de "passou" e libera o send com texto substituído.
        } else {
          // Nenhum match: passthrough seguro (mensagem original já legitimamente
          // checada — não é mais "pending" como no Bloco 4). Mantemos o evento
          // dedicado para observabilidade do stage assistido.
          ctx.eventBus.emit(
            'assisted_mode_passthrough',
            {
              contact_id: ctx.contact.id,
              lead_id: leadId,
              ai_state: aiState,
              part_index: ctx.partIndex,
              part_total: ctx.partTotal,
              classifier_pending: false,
              classifier_match: null,
            },
            'info',
          );
        }
      } else {
        // Config faltando: comportamento Bloco 4 preservado (passthrough +
        // marker `classifier_pending=true`). Útil se v3 do agent_configs
        // perder os campos por engano (defensive — não bloqueia o atendimento).
        ctx.eventBus.emit(
          'assisted_mode_passthrough',
          {
            contact_id: ctx.contact.id,
            lead_id: leadId,
            ai_state: aiState,
            part_index: ctx.partIndex,
            part_total: ctx.partTotal,
            classifier_pending: true,
            classifier_config_missing: true,
          },
          'info',
        );
      }
      // Continua para o trace de "passou" e libera o send.
    }

    // Trace de "passou" para correlacionar no painel — útil para confirmar
    // que cada turno realmente bate aqui antes do send (auditoria da
    // invariante 1).
    ctx.eventBus.emitHook(
      'response-guard',
      'BEFORE_SEND',
      {
        passed: true,
        ai_state: aiState,
        is_human_active: isHumanActive,
        handoff_assumed_at_set: assumedAtSet,
        // Distingue 3b (libera assistido) de 4 (livre normal) nos traces.
        assisted_mode: isHumanActive && !assumedAtSet,
      },
      'info',
    );

    return {};
  },
};
