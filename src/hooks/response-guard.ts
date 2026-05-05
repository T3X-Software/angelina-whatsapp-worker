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
// Precedência (concept ai-state-control):
//   1. contacts.ai_state = 'HUMAN_TAKEOVER' → bloqueia tudo
//   2. contacts.ai_state = 'PAUSED'         → bloqueia tudo
//   3. leads.is_human_active = true         → bloqueia IA neste lead
//   4. caso contrário                        → IA responde normalmente
//
// Quando bloqueia: emit `send_blocked` (severity 'info' — não é erro, é o
// guard fazendo o trabalho dele) com `{reason, ai_state, is_human_active}`,
// retorna `{shortCircuit: true}`. O loop.ts marca o outbound já criado como
// `failed` antes de retornar.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { Hook, HookResult, HarnessContext } from '../harness/types';

interface GuardRow {
  ai_state: string;
  is_human_active: boolean | null;
  [key: string]: unknown;
}

export const responseGuard: Hook = {
  name: 'response-guard',
  phase: 'BEFORE_SEND',

  async run(ctx: HarnessContext): Promise<HookResult> {
    // Query única: contacts.ai_state + leads.is_human_active (LEFT JOIN para
    // tolerar contato sem lead — `COALESCE(false)` mantém o boolean NOT NULL).
    const leadId = ctx.lead?.id ?? null;

    const rows = await db.execute<GuardRow>(sql`
      SELECT c.ai_state                                 AS ai_state,
             COALESCE(l.is_human_active, false)         AS is_human_active
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

    let reason: string | null = null;
    if (aiState === 'HUMAN_TAKEOVER') {
      reason = 'ai_state=HUMAN_TAKEOVER';
    } else if (aiState === 'PAUSED') {
      reason = 'ai_state=PAUSED';
    } else if (isHumanActive) {
      reason = 'is_human_active=true';
    }

    if (reason) {
      ctx.eventBus.emit(
        'send_blocked',
        {
          reason,
          ai_state: aiState,
          is_human_active: isHumanActive,
          contact_id: ctx.contact.id,
          lead_id: leadId,
        },
        'info',
      );
      return { shortCircuit: true };
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
      },
      'info',
    );

    return {};
  },
};
