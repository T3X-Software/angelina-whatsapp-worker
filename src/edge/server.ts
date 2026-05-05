// src/edge/server.ts
//
// Camada HTTP do worker (Fastify).
// Responsabilidade ÚNICA: criar a instância e expor `start(server, port)`.
// As rotas reais (POST /webhooks/zapster/:token) são registradas em
// `src/edge/webhook.ts` via `registerWebhookRoutes(server)`, chamada pelo
// `main.ts` após a criação aqui.
//
// Bloco 2 — extraído de `main.ts` para isolar responsabilidades e permitir
// testes manuais/E2E que sobem só o HTTP sem precisar do BullMQ Worker.

import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import type { Logger } from 'pino';

/**
 * Cria uma instância Fastify pronta para uso, com:
 *   - bodyLimit 1 MiB (webhook Zapster é pequeno)
 *   - trustProxy (para Nginx em prod)
 *   - logger interno do Fastify desligado (usamos pino próprio)
 *   - `@fastify/formbody` registrado (Zapster pode mandar
 *      `application/x-www-form-urlencoded` ou `application/json`)
 *   - `GET /healthz` retornando `{ ok: true }`
 *
 * As rotas de webhook são registradas separadamente — esta função NÃO conhece
 * o handler da Zapster.
 */
export async function createServer(logger: Logger): Promise<FastifyInstance> {
  // O TS do Fastify infere o tipo do logger pelo objeto passado em
  // `loggerInstance`, e o pino `Logger` tem `msgPrefix` (ausente no
  // `FastifyBaseLogger`), o que quebra a inferência genérica.
  // Ignoramos a inferência específica e cast no resultado para o
  // `FastifyInstance` padrão — em runtime o pino implementa todos os métodos
  // que o Fastify usa.
  const app = Fastify({
    // Usa o pino externo como logger do Fastify — assim `request.log.info/warn/error`
    // emitem para o mesmo stream do worker (e não para um stub silencioso).
    // `disableRequestLogging:true` silencia o "incoming request"/"request completed"
    // padrão do Fastify; usamos nosso próprio `addHook('onResponse')` abaixo para
    // registrar latência em debug-level com o token redacted.
    loggerInstance: logger.child({ subsystem: 'fastify' }),
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024, // 1 MiB
    trustProxy: true,
  }) as unknown as FastifyInstance;

  await app.register(formbody);

  app.get('/healthz', async () => ({ ok: true }));

  // Hook genérico de log de request finalizada (debug-level — visível só com LOG_LEVEL=debug).
  // Útil para auditar latência durante o smoke do Bloco 2 sem poluir prod.
  app.addHook('onResponse', async (request, reply) => {
    logger.debug(
      {
        method: request.method,
        url: redactPathToken(request.url),
        statusCode: reply.statusCode,
        // Fastify expõe responseTime em ms (float)
        responseTimeMs: reply.elapsedTime,
      },
      'request completed',
    );
  });

  return app;
}

/**
 * Faz `server.listen(...)` com host 0.0.0.0 (necessário para Docker/Nginx em
 * prod). Resolve quando o socket está pronto.
 */
export async function start(server: FastifyInstance, port: number): Promise<void> {
  await server.listen({ port, host: '0.0.0.0' });
}

/**
 * Redacta o token secreto da URL antes de loggar (`/webhooks/zapster/<token>`
 * vira `/webhooks/zapster/<redacted>`). Outras rotas passam intactas.
 *
 * O token é um secret — NUNCA pode aparecer em logs (ver brief, atenção do
 * Bloco 2: "Token na URL é segredo. Em logs, NUNCA logar a URL completa").
 */
function redactPathToken(url: string): string {
  return url.replace(/(\/webhooks\/zapster\/)[^/?#]+/i, '$1<redacted>');
}
