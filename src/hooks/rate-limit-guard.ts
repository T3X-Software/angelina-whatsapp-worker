// src/hooks/rate-limit-guard.ts
//
// Bloco 6 — Task 32. PRIMEIRO hook de BEFORE_REQUEST (INVARIANTE 2).
//
// Conta mensagens INBOUND do contato na última hora; se >= max_turns_per_hour
// (de `agent_configs.hookParams.rate_limit.max_turns_per_hour`, default 30),
// emite trace `rate_limit_hit` (severity 'med') e short-circuita o turno
// com uma `response` curta que (eventualmente) será enviada ao cliente.
//
// IMPORTANTE: o filtro `direction='INBOUND'` é deliberado — rate-limit é
// sobre o que o CONTATO está mandando para a Angelina, não sobre as respostas
// da IA. Se contássemos OUTBOUND, um cenário com 30 respostas (loop infinito,
// teste, ataque ao próprio agente) trancaria o contato sem culpa dele.
//
// IMPORTANTE 2: este hook NÃO chama o LLM (invariante 3) e NÃO envia
// mensagem (invariante 4). Apenas marca o short-circuit; quem decide o que
// fazer com `response` é o `loop.ts` (que pode usar um caminho de envio
// próprio futuro — ver decisão no log Bloco 6).

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { Hook, HookResult, HarnessContext } from '../harness/types';

const DEFAULT_MAX_TURNS_PER_HOUR = 30;

interface RateLimitParams {
  max_turns_per_hour?: number;
}

interface HookParamsShape {
  rate_limit?: RateLimitParams;
}

export const rateLimitGuard: Hook = {
  name: 'rate-limit-guard',
  phase: 'BEFORE_REQUEST',

  async run(ctx: HarnessContext): Promise<HookResult> {
    const params = (ctx.config?.hookParams ?? {}) as HookParamsShape;
    const max =
      params.rate_limit?.max_turns_per_hour ?? DEFAULT_MAX_TURNS_PER_HOUR;

    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM messages
       WHERE contact_id = ${ctx.contact.id}
         AND direction = 'INBOUND'
         AND created_at > now() - interval '1 hour'
    `);
    const arr = Array.from(rows) as Array<{ n: number }>;
    const count = arr[0]?.n ?? 0;

    ctx.eventBus.emitHook(
      'rate-limit-guard',
      'BEFORE_REQUEST',
      { count_inbound_last_hour: count, max_turns_per_hour: max },
      'info',
    );

    if (count >= max) {
      ctx.eventBus.emit(
        'rate_limit_hit',
        {
          contact_id: ctx.contact.id,
          count_inbound_last_hour: count,
          max_turns_per_hour: max,
        },
        'med',
      );
      return {
        shortCircuit: true,
        response:
          'Você está enviando muitas mensagens. Volto em alguns minutos.',
      };
    }

    return {};
  },
};
