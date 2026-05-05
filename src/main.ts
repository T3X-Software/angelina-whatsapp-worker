// src/main.ts
//
// Entrypoint do worker. Boot único responsável por:
//   1. Validar env vars (via import de `./env` — falha rápido se faltar algo).
//   2. Validar Redis (PING) — falha rápido se inacessível (Bloco 3+ exige).
//   3. Subir Fastify HTTP server (edge handler) com /healthz e a rota
//      POST /webhooks/zapster/:token (Bloco 2).
//   4. Subir BullMQ Worker (consumer da queue `inbound`) e anexar DLQ handler.
//   5. Registrar SIGTERM/SIGINT para graceful shutdown.
//
// Bloco 0: HTTP + worker stub (Redis tolerante a offline para smoke).
// Bloco 2: edge handler real (rotas, auth, fast-ACK) acoplado.
// Bloco 3: producer/consumer/debouncer/dlq REAIS — Redis OBRIGATÓRIO no boot.
// Bloco 5+: HarnessLoop dentro do consumer.

import type { FastifyInstance } from 'fastify';
import type { Worker } from 'bullmq';
import pino from 'pino';

import { env } from './env';
import { createServer, start as startServer } from './edge/server';
import { registerWebhookRoutes } from './edge/webhook';
import { validateRedis, closeRedis } from './queue/connection';
import { closeInboundQueue } from './queue/producer';
import { startConsumer, closeConsumer } from './queue/consumer';
import { attachDLQHandler } from './queue/dlq-handler';
import { closeDb } from './db/client';

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const logger = pino({
  level: env.LOG_LEVEL,
  // Pretty em dev (NODE_ENV !== 'production'). Em prod, JSON estruturado puro.
  ...(process.env.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});

// ─────────────────────────────────────────────────────────────────────────────
// Estado do processo (para graceful shutdown)
// ─────────────────────────────────────────────────────────────────────────────

let server: FastifyInstance | null = null;
let bullWorker: Worker | null = null;
let shuttingDown = false;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server (Bloco 0 + Bloco 2)
// ─────────────────────────────────────────────────────────────────────────────

async function startHttpServer(): Promise<FastifyInstance> {
  const app = await createServer(logger);

  // Acopla as rotas reais do webhook Zapster (Bloco 2).
  registerWebhookRoutes(app);

  await startServer(app, env.LUA_HTTP_PORT);
  logger.info({ port: env.LUA_HTTP_PORT }, 'HTTP server listening');
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received — closing resources');

  // Fecha o HTTP primeiro (para de aceitar novos webhooks).
  if (server) {
    try {
      await server.close();
      logger.info('HTTP server closed');
    } catch (err) {
      logger.error({ err }, 'Error closing HTTP server');
    }
  }

  // Depois o BullMQ Worker (deixa terminar o job em flight, respeita lockDuration).
  if (bullWorker) {
    try {
      await closeConsumer();
      logger.info('BullMQ consumer closed');
    } catch (err) {
      logger.error({ err }, 'Error closing BullMQ consumer');
    }
  }

  // Producer queue (singleton da side do producer — fecha conexões dela).
  try {
    await closeInboundQueue();
    logger.info('BullMQ producer queue closed');
  } catch (err) {
    logger.error({ err }, 'Error closing BullMQ producer queue');
  }

  // Conexão Redis singleton (BullMQ + debouncer).
  try {
    await closeRedis();
    logger.info('Redis disconnected');
  } catch (err) {
    logger.error({ err }, 'Error closing Redis');
  }

  // Por fim, a connection pool Postgres (Drizzle/postgres-js).
  // Última a fechar para que qualquer flush remanescente de traces (Bloco 5+)
  // ou cleanup transacional ainda possa ir ao banco antes do exit.
  try {
    await closeDb();
    logger.info('Database disconnected');
  } catch (err) {
    logger.error({ err }, 'Error closing database');
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  void shutdown('uncaughtException');
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('whatsapp-worker booting');

  // 1. Redis OBRIGATÓRIO no Bloco 3+. Falha rápido se inacessível.
  await validateRedis(logger);

  // 2. HTTP server (edge handler).
  server = await startHttpServer();

  // 3. BullMQ consumer + DLQ handler.
  bullWorker = startConsumer(logger);
  attachDLQHandler(bullWorker, logger);

  logger.info('whatsapp-worker ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'Boot failed');
  process.exit(1);
});
