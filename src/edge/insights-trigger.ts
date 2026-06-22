// src/edge/insights-trigger.ts
//
// Feature `conversation-insights`.
//
// Rota interna POST /internal/insights/run — dispara o agente analista
// on-demand a partir do app web (server-to-server na rede Docker, nunca
// exposta fora). Espelha o padrão do webhook Zapster: preHandler de auth +
// fast-ACK + setImmediate para o trabalho pesado.
//
// Auth: header `Authorization: Bearer <INSIGHTS_TRIGGER_SECRET>`. Se o secret
// não estiver configurado no worker → 503 (endpoint desabilitado). Mismatch → 401.
//
// NÃO chama LLM nem banco no preHandler — só autentica. O trabalho real roda
// depois do ACK.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';

import { env } from '../env';
import { prepareOnDemandRun, runInsightsAnalyst } from '../jobs/insights-analyst';

const bodySchema = z
  .object({
    scope: z.enum(['all', 'contactIds']).default('all'),
    contactIds: z.array(z.string().uuid()).max(50).optional(),
    maxConversations: z.number().int().positive().max(100).optional(),
  })
  .strict();

function bearerAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const secret = env.INSIGHTS_TRIGGER_SECRET;
  if (!secret) {
    request.log.warn({ event: 'insights_trigger_unconfigured' }, 'INSIGHTS_TRIGGER_SECRET not set');
    void reply.code(503).send({ error: 'analyst_unavailable' });
    return false;
  }
  const header = String(request.headers['authorization'] ?? '');
  const expected = `Bearer ${secret}`;
  // Comparação simples de comprimento + igualdade. O secret tem ≥16 chars de
  // entropia; timing-attack aqui é irrelevante (rede interna, não exposta).
  if (header.length !== expected.length || header !== expected) {
    request.log.warn({ event: 'insights_trigger_auth_failed' }, 'bad bearer');
    void reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function registerInsightsTriggerRoute(server: FastifyInstance): void {
  server.post('/internal/insights/run', async (request, reply) => {
    if (!bearerAuth(request, reply)) return;

    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 3) });
      return;
    }
    const { scope, contactIds, maxConversations } = parsed.data;
    if (scope === 'contactIds' && (!contactIds || contactIds.length === 0)) {
      await reply.code(400).send({ error: 'contactIds_required_for_scope' });
      return;
    }

    // Cria a run (running) para devolver o id imediatamente. null = analista
    // indisponível (sem config / disabled).
    const runId = await prepareOnDemandRun();
    if (!runId) {
      await reply.code(503).send({ error: 'analyst_unavailable' });
      return;
    }

    // Fast-ACK: devolve o runId; o trabalho roda após o flush da resposta.
    await reply.code(202).send({ runId });

    setImmediate(() => {
      runInsightsAnalyst({
        trigger: 'on_demand',
        runId,
        contactIds: scope === 'contactIds' ? contactIds : undefined,
        maxConversations,
        logger: request.log as never,
      }).catch((err) => {
        request.log.error(
          { event: 'insights_on_demand_uncaught', runId, err: err?.message ?? String(err) },
          'on-demand insights run threw',
        );
      });
    });
  });
}
