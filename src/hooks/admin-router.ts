// src/hooks/admin-router.ts
//
// Bloco 6 — Task 33. BEFORE_REQUEST (entre rate-limit-guard e load-context).
//
// Detecta comandos administrativos enviados por números na whitelist
// `agent_configs.hookParams.admin_phones`. Quando aciona, escreve
// `contacts.ai_state` (controle MANUAL — concept `ai-state-control`) e/ou
// outros side-effects, e short-circuita o turno com uma resposta curta de
// confirmação.
//
// Comandos atuais:
//   - `/pausar`     → ai_state=PAUSED         (admin-only)
//   - `/retomar`    → ai_state=AUTO           (admin-only)
//   - `/transferir` → ai_state=HUMAN_TAKEOVER (admin-only)
//   - `/status`     → resposta read-only      (admin-only)
//   - `/limpar`     → soft-redact L1 do contato  (PÚBLICO — ver FIXME abaixo)
//
// Decisão (registrada no log do Bloco 6 — abertura): a `response` retornada
// neste hook (ex.: "✅ Agente pausado.") fica no contexto via `responseToSend`
// no `loop.ts`. Quem efetivamente envia ao admin é decidido no Bloco 9 (canal
// próprio fora do pipeline normal — response-guard nem roda porque o turno
// foi cortado em BEFORE_REQUEST).
//
// IMPORTANTE: NÃO escreve `leads.is_human_active` (controle automático fica
// para `transfer-trigger`). NÃO chama LLM (invariante 3). NÃO envia mensagem
// neste arquivo (invariante 4).

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { Hook, HookResult, HarnessContext } from '../harness/types';

type AdminCommand =
  | 'pausar'
  | 'retomar'
  | 'transferir'
  | 'status'
  | 'limpar';

interface HookParamsShape {
  admin_phones?: string[];
}

const ADMIN_REGEX =
  /^\s*\/(pausar|retomar|transferir|status|limpar)\b/i;

/** Comandos liberados para QUALQUER phone durante o hardening local.
 *  FIXME(testing): voltar para admin-only antes de produção (mover `limpar`
 *  para o conjunto admin junto com pausar/retomar/transferir/status). */
const PUBLIC_COMMANDS: ReadonlySet<AdminCommand> = new Set(['limpar']);

const COMMAND_TO_NEW_STATE: Record<
  Exclude<AdminCommand, 'status' | 'limpar'>,
  'PAUSED' | 'AUTO' | 'HUMAN_TAKEOVER'
> = {
  pausar: 'PAUSED',
  retomar: 'AUTO',
  transferir: 'HUMAN_TAKEOVER',
};

const COMMAND_TO_RESPONSE: Record<
  Exclude<AdminCommand, 'status' | 'limpar'>,
  string
> = {
  pausar: '✅ Agente pausado. Use /retomar para reativar.',
  retomar: '✅ Agente reativado.',
  transferir:
    '✅ Atendimento agora é humano. Use /retomar para devolver ao agente.',
};

export const adminRouter: Hook = {
  name: 'admin-router',
  phase: 'BEFORE_REQUEST',

  async run(ctx: HarnessContext): Promise<HookResult> {
    const text = ctx.message.text;
    if (!text) {
      return {};
    }

    const match = ADMIN_REGEX.exec(text);
    if (!match) {
      return {};
    }

    const command = match[1].toLowerCase() as AdminCommand;

    // FIXME(testing): comandos em `PUBLIC_COMMANDS` ignoram a whitelist
    // durante o hardening local. Reverter antes de produção.
    if (!PUBLIC_COMMANDS.has(command)) {
      const params = (ctx.config?.hookParams ?? {}) as HookParamsShape;
      const adminPhones = params.admin_phones ?? [];

      if (!adminPhones.includes(ctx.contact.phone)) {
        // Comando bate o regex mas o phone NÃO é admin — segue o pipeline
        // normal (a IA pode tratar a mensagem como qualquer outra). Não emite
        // trace para não vazar tentativa de impersonation no log; o sender
        // passa adiante.
        return {};
      }
    }

    // Lê o estado atual do contato (precisamos do prev_state para o trace).
    const prevRows = await db.execute<{ ai_state: string }>(sql`
      SELECT ai_state FROM contacts WHERE id = ${ctx.contact.id} LIMIT 1
    `);
    const prevArr = Array.from(prevRows) as Array<{ ai_state: string }>;
    const prevState = prevArr[0]?.ai_state ?? 'AUTO';

    if (command === 'limpar') {
      // FIXME(testing): comando público durante o hardening local. Marca todas
      // as `messages` do contato como redacted (`redacted_at = now()`) — o L1
      // composer filtra `WHERE redacted_at IS NULL`, então o LLM passa a ver
      // o histórico zerado a partir do próximo turno. Não toca em `leads`,
      // `contact_facts`, `contacts.name`, nem `is_human_active`. Auditoria
      // preservada (rows continuam no banco).
      const updateRows = await db.execute<{ id: string }>(sql`
        UPDATE messages
           SET redacted_at = now()
         WHERE contact_id = ${ctx.contact.id}
           AND redacted_at IS NULL
        RETURNING id
      `);
      const redactedCount = Array.from(updateRows).length;

      ctx.eventBus.emit(
        'admin_command_executed',
        {
          command,
          by_phone: ctx.contact.phone,
          contact_id: ctx.contact.id,
          redacted_count: redactedCount,
        },
        'info',
      );

      return {
        shortCircuit: true,
        response: `🧹 Histórico limpo (${redactedCount} mensagens). Próximo turno começa do zero.`,
      };
    }

    if (command === 'status') {
      // Sem UPDATE; só responde o estado atual.
      // Lê também o is_human_active do lead ativo (se houver).
      let isHumanActive = false;
      if (ctx.lead?.id) {
        const leadRows = await db.execute<{ is_human_active: boolean }>(sql`
          SELECT is_human_active FROM leads WHERE id = ${ctx.lead.id} LIMIT 1
        `);
        const leadArr = Array.from(leadRows) as Array<{
          is_human_active: boolean;
        }>;
        isHumanActive = leadArr[0]?.is_human_active ?? false;
      }
      const response = `Estado atual: ai_state=${prevState}, is_human_active=${isHumanActive}.`;

      ctx.eventBus.emit(
        'admin_command_executed',
        {
          command,
          by_phone: ctx.contact.phone,
          contact_id: ctx.contact.id,
          prev_state: prevState,
        },
        'info',
      );
      return { shortCircuit: true, response };
    }

    const newState = COMMAND_TO_NEW_STATE[command];
    await db.execute(sql`
      UPDATE contacts SET ai_state = ${newState} WHERE id = ${ctx.contact.id}
    `);

    ctx.eventBus.emit(
      'admin_command_executed',
      {
        command,
        by_phone: ctx.contact.phone,
        contact_id: ctx.contact.id,
        prev_state: prevState,
        new_state: newState,
      },
      'info',
    );

    return {
      shortCircuit: true,
      response: COMMAND_TO_RESPONSE[command],
    };
  },
};
