// src/queue/dlq-handler.ts
//
// Listeners de falha do BullMQ Worker. Em particular:
//
//  - `worker.on('failed', job, err)` dispara em CADA tentativa que falha.
//    Quando `job.attemptsMade >= job.opts.attempts` (default 3), considera-se
//    que o job morreu e foi para a "DLQ" (na prática, o Redis preserva o
//    job no estado `failed` com `removeOnFail: { count: 100 }` configurado
//    no producer). Emitimos `worker_dead` (severity: 'high') com payload+stack.
//
//  - `worker.on('error', err)` dispara para erros NÃO ligados a job
//    específico (problema de conexão Redis, bug interno, etc). Loga como
//    severity: 'high' também.
//
// Trace DB-level vai entrar no Bloco 5 #26 (EventBus). Por enquanto, log
// estruturado é suficiente — chega no stdout do worker e, em prod, no
// Docker/Loki.

import type { Worker, Job } from 'bullmq';

import type { InboundJobData } from './producer';

export type MinimalLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * Anexa os listeners de falha ao Worker. Idempotente (chamadas múltiplas
 * adicionam handlers múltiplos — chamar UMA vez no boot).
 */
export function attachDLQHandler(
  worker: Worker<InboundJobData>,
  logger: MinimalLogger,
): void {
  worker.on('failed', (job: Job<InboundJobData> | undefined, err: Error) => {
    if (!job) {
      logger.error(
        {
          event: 'job_failed_no_context',
          severity: 'high',
          err: err.message,
          stack: err.stack,
        },
        'job failed without context',
      );
      return;
    }

    const attempts = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 3;
    const isDead = attempts >= maxAttempts;

    if (isDead) {
      logger.error(
        {
          event: 'worker_dead',
          severity: 'high',
          jobId: job.id,
          name: job.name,
          attempts,
          maxAttempts,
          phone: job.data?.phone,
          zapster_message_id: job.data?.headers?.['x-message-id'],
          message_type: job.data?.payload?.data?.message?.type,
          err: err.message,
          stack: err.stack,
        },
        `worker_dead jobId=${job.id} attempts=${attempts}/${maxAttempts}`,
      );
    } else {
      logger.warn(
        {
          event: 'job_attempt_failed',
          jobId: job.id,
          name: job.name,
          attempts,
          maxAttempts,
          phone: job.data?.phone,
          err: err.message,
        },
        `job attempt failed (${attempts}/${maxAttempts}) — will retry`,
      );
    }
  });

  worker.on('error', (err: Error) => {
    logger.error(
      {
        event: 'worker_error',
        severity: 'high',
        err: err.message,
        stack: err.stack,
      },
      'BullMQ worker error',
    );
  });
}
