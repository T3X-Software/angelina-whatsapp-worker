// src/queue/producer.ts
//
// Producer da queue `inbound`. Atualizado em 2026-05-04 (segunda iteração do
// fix de duplicidade) para abandonar o `jobId` per-phone via changeDelay.
//
// Razão da mudança: o `jobId = lua-bucket-{phone}` ficava "queimado" no set
// `completed` do BullMQ depois que o consumer terminava o job. Nova chamada
// `queue.add` com mesmo jobId deduplicava contra o job completado e o novo
// payload era silenciosamente descartado da fila (sem entrar em delayed).
//
// Estratégia atual:
//   1. **Append per-phone** na LIST Redis (sem mudança) — `appendToBucket(phone)`
//      acumula payloads na chave `lua:debounce:{phone}` (TTL 10s).
//   2. **Job único por webhook**: `jobId = lua-msg-{zapster_message_id}`.
//      Cada webhook do Zapster gera 1 job BullMQ próprio. Idempotência
//      automática contra retransmits do Zapster (mesma message_id → mesmo
//      jobId → BullMQ retorna o existente sem duplicar). Mirror do UNIQUE
//      em `messages.zapster_message_id`.
//   3. **Delay = bucketSize (~2.5s)**. O consumer só fira após esse atraso,
//      dando tempo para mais webhooks do contato chegarem.
//   4. **Consolidação no consumer**: o PRIMEIRO job a rodar para um contato
//      em burst dreniza a LIST inteira via `drainBucket(phone)` e processa
//      tudo como UM turno. Os jobs irmãos do mesmo burst chegam logo depois,
//      encontram o bucket vazio, caem no sentinel — e o `claimMessage` no
//      harness retorna `duplicate_skipped` (zapster_message_id já claimado
//      pelo pre-claim do primeiro job). Sem resposta duplicada.
//
// Não envia mensagem, não chama LLM, não toca banco — só Redis.

import { Queue, type JobsOptions } from 'bullmq';

import type { WebhookPayload } from '../edge/payload';
import { getRedis } from './connection';
import { appendToBucket, bucketSize } from './debouncer';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export type RelevantHeaders = {
  'x-message-id'?: string;
  'x-instance-id'?: string;
  'x-webhook-id'?: string;
  'x-attempt-count'?: string;
};

/** Compatível com pino.Logger E FastifyBaseLogger. */
export type MinimalLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * Forma do job que o consumer recebe. Inclui:
 *  - `phone` (para o consumer fazer `drainBucket`)
 *  - `payload`/`headers` da mensagem que ORIGINOU este job (sentinel —
 *    útil quando `drainBucket` retorna vazio porque outro job irmão drenou).
 */
export type InboundJobData = {
  phone: string;
  payload: WebhookPayload;
  headers: RelevantHeaders;
};

// ─────────────────────────────────────────────────────────────────────────────
// Queue singleton
// ─────────────────────────────────────────────────────────────────────────────

export const QUEUE_NAME = 'inbound';

let cachedQueue: Queue<InboundJobData> | null = null;

/** Singleton da Queue. Cria na 1ª chamada usando o singleton de connection. */
export function getInboundQueue(): Queue<InboundJobData> {
  if (cachedQueue) return cachedQueue;

  cachedQueue = new Queue<InboundJobData>(QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 100 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  });

  return cachedQueue;
}

/** Fecha a queue. Usado pelo graceful shutdown. Idempotente. */
export async function closeInboundQueue(): Promise<void> {
  if (!cachedQueue) return;
  try {
    await cachedQueue.close();
  } catch {
    // ignore
  } finally {
    cachedQueue = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública usada pelo edge/webhook.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acumula payload na LIST Redis e enfileira um job BullMQ único por webhook.
 *
 * Sempre resolve sem throw (catches internos logam). O caller (webhook.ts)
 * já fez fast-ACK; falhas aqui só vão para o log/alerta.
 */
export async function enqueueInbound(
  payload: WebhookPayload,
  headers: RelevantHeaders,
  logger: MinimalLogger,
): Promise<void> {
  const phone = payload.data.sender.id;
  const zapsterMessageId =
    headers['x-message-id'] ?? payload.data.message.id ?? '(missing)';
  // jobId atrelado ao zapster_message_id: idempotência automática contra
  // retransmits + nunca colide com jobs anteriores do mesmo contato.
  const jobId = `lua-msg-${zapsterMessageId}`;

  // 1. Acumula payload na LIST per-phone (consolidação no consumer).
  const redis = getRedis();
  try {
    await appendToBucket(redis, phone, { payload, headers });
  } catch (err) {
    logger.error(
      {
        event: 'append_to_bucket_failed',
        err: err instanceof Error ? err.message : String(err),
        phone,
        zapster_message_id: zapsterMessageId,
      },
      'Failed to RPUSH payload into Redis bucket',
    );
    // Continuamos mesmo assim — o sentinel no jobData carrega ao menos esta
    // mensagem para o consumer processar algo (path degradado).
  }

  // 2. Enfileira o job BullMQ. jobId único por webhook → nunca conflita.
  const queue = getInboundQueue();
  const jobData: InboundJobData = { phone, payload, headers };
  const jobOpts: JobsOptions = {
    jobId,
    delay: bucketSize, // janela de consolidação (~2.5s)
    // attempts/backoff/removeOn* herdam de defaultJobOptions
  };

  try {
    await queue.add('process', jobData, jobOpts);
    logger.info(
      {
        event: 'enqueued',
        jobId,
        phone,
        zapster_message_id: zapsterMessageId,
        message_type: payload.data.message.type,
        delay_ms: bucketSize,
      },
      `enqueued zapster_message_id=${zapsterMessageId} jobId=${jobId}`,
    );
  } catch (err) {
    logger.error(
      {
        event: 'enqueue_failed',
        err: err instanceof Error ? err.message : String(err),
        jobId,
        phone,
        zapster_message_id: zapsterMessageId,
      },
      'Failed to enqueue inbound job',
    );
  }
}
