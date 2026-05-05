// src/edge/zapster-auth.ts
//
// preHandler hook do Fastify para validar webhooks do Zapster em 4 camadas
// (ordem importa — cada camada tem código HTTP distinto e precede a próxima):
//
//   1. Token URL  (`:token` do path) → `env.ZAPSTER_WEBHOOK_TOKEN`     → 404
//      (404 — não 401 — para que scanners não saibam que existe um endpoint)
//   2. Headers `x-instance-id` + `x-webhook-id` → env vars              → 403
//   3. User-Agent começa com `Zapsterapi/`                               → 401
//   4. Payload Zod (parseWebhookPayload em `payload.ts`)                 → 400
//
// Em caso de falha, anota o motivo no log (warn) e responde com o status
// correto. Em caso de sucesso, anexa o payload normalizado em
// `request.zapsterPayload` e libera para o handler do webhook.
//
// IMPORTANTE: este preHandler NUNCA deve chamar LLM, banco ou enfileirar.
// É apenas autenticação + validação de schema.

import type { FastifyRequest, FastifyReply } from 'fastify';

import { env } from '../env';
import { parseWebhookPayload, type WebhookPayload } from './payload';

// Augmenta o tipo do FastifyRequest para incluir o payload normalizado.
// Declarar aqui (e não em arquivo separado) facilita ler o contrato junto
// do código que produz/consome o campo.
declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyRequest {
    zapsterPayload?: WebhookPayload;
  }
}

const UA_RE = /^Zapsterapi\//;

type TokenParams = { token?: string };

export async function zapsterAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = (request.params ?? {}) as TokenParams;
  const ip = request.ip;
  const ua = String(request.headers['user-agent'] ?? '');

  // ── Camada 1: token na URL (404) ────────────────────────────────────────
  // 404 (não 401) é intencional: scanners genéricos veem "rota inexistente".
  // NUNCA loggar o token recebido — comparar e descartar.
  if (!params.token || params.token !== env.ZAPSTER_WEBHOOK_TOKEN) {
    request.log.warn(
      { event: 'auth_token_mismatch', ip, ua },
      'Zapster auth: path token mismatch',
    );
    await reply.code(404).send();
    return;
  }

  // ── Camada 2: headers x-instance-id e x-webhook-id (403) ────────────────
  const receivedInstance = String(request.headers['x-instance-id'] ?? '');
  const receivedWebhook = String(request.headers['x-webhook-id'] ?? '');
  if (
    receivedInstance !== env.ZAPSTER_INSTANCE_ID ||
    receivedWebhook !== env.ZAPSTER_WEBHOOK_ID
  ) {
    request.log.warn(
      {
        event: 'auth_header_mismatch',
        received_instance: receivedInstance || '(missing)',
        received_webhook: receivedWebhook || '(missing)',
        ip,
        ua,
      },
      'Zapster auth: x-instance-id / x-webhook-id mismatch',
    );
    await reply.code(403).send();
    return;
  }

  // ── Camada 3: User-Agent (401) ──────────────────────────────────────────
  if (!UA_RE.test(ua)) {
    request.log.warn(
      { event: 'auth_ua_invalid', ua, ip },
      'Zapster auth: User-Agent does not match Zapsterapi/*',
    );
    await reply.code(401).send();
    return;
  }

  // ── Camada 4: payload Zod (400) ─────────────────────────────────────────
  const result = parseWebhookPayload(request.body);
  if (!result.success) {
    // Limita issues a 3 itens para não inflar logs com payloads enormes.
    const issues = result.error.issues.slice(0, 3).map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    request.log.warn(
      { event: 'auth_payload_invalid', issues, ip },
      'Zapster auth: payload failed Zod validation',
    );
    await reply.code(400).send({ error: 'invalid_payload' });
    return;
  }

  // Tudo certo — anexa o payload normalizado.
  request.zapsterPayload = result.data;
}
