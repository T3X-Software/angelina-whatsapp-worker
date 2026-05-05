// src/edge/webhook.ts
//
// Rota POST /webhooks/zapster/:token.
//
// Fluxo:
//   1. preHandler `zapsterAuth` valida 4 camadas (token / headers / UA / Zod payload).
//      Em qualquer falha, responde 404/403/401/400 e a chain encerra.
//   2. Se passou, anexou `request.zapsterPayload`.
//   3. **Fast-ACK PRIMEIRO**: `reply.code(200).send({ok:true})` ANTES de qualquer
//      trabalho — Zapster considera entrega ok imediatamente; duplicatas são tratadas
//      pela idempotência no consumer (Bloco 5 #28).
//   4. `setImmediate(() => enqueueInbound(...))` agenda o trabalho real para depois
//      do ACK. Falhas no enqueue são logadas mas NÃO retornam ao cliente
//      (já recebeu 200).
//
// Esta camada NÃO chama LLM, NÃO escreve no banco, NÃO envia mensagem ao cliente.
// É apenas HTTP intake + agendamento.

import type { FastifyInstance } from 'fastify';

import { zapsterAuth } from './zapster-auth';
import { enqueueInbound, type RelevantHeaders } from '../queue/producer';

type TokenParams = { token: string };

export function registerWebhookRoutes(server: FastifyInstance): void {
  server.post<{ Params: TokenParams }>(
    '/webhooks/zapster/:token',
    {
      // preHandler no nível da rota — outras rotas (ex.: /healthz) ficam intactas.
      preHandler: zapsterAuth,
    },
    async (request, reply) => {
      // Pega payload validado pelo preHandler. O `!` é seguro porque chegar
      // aqui implica em todas as 4 camadas de auth terem passado.
      const payload = request.zapsterPayload!;

      // Headers relevantes para idempotência e dedup. Strings (Fastify pode
      // entregar string | string[] | undefined; coercion via String()).
      const headers: RelevantHeaders = {
        'x-message-id': asString(request.headers['x-message-id']),
        'x-instance-id': asString(request.headers['x-instance-id']),
        'x-webhook-id': asString(request.headers['x-webhook-id']),
        'x-attempt-count': asString(request.headers['x-attempt-count']),
      };

      // ── Fast-ACK PRIMEIRO ─────────────────────────────────────────────
      // Antes de qualquer trabalho. Zapster libera o retry timer aqui.
      reply.code(200).send({ ok: true });

      // ── Trabalho real agendado para depois do ACK ─────────────────────
      // setImmediate cede o tick atual antes de executar — garante que o
      // socket de resposta foi flushado.
      setImmediate(() => {
        enqueueInbound(payload, headers, request.log).catch((err) => {
          // Falha no enqueue NÃO volta para o cliente (já recebeu 200).
          // Apenas loga. Em prod (Bloco 3+), esse erro vai para alerta.
          request.log.error(
            {
              event: 'enqueue_failed',
              err: err instanceof Error ? err.message : String(err),
              zapster_message_id: headers['x-message-id'],
            },
            'Failed to enqueue inbound webhook',
          );
        });
      });
    },
  );
}

/**
 * Coerção segura de header → string. Headers Fastify podem ser
 * `string | string[] | undefined`. Para os 4 headers que usamos, queremos sempre
 * string única (ou undefined).
 */
function asString(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}
