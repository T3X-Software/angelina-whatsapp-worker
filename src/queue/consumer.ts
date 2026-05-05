// src/queue/consumer.ts
//
// BullMQ Worker da queue `inbound`. Substitui o stub do Bloco 0 em main.ts.
//
// Comportamento por job (atualizado no Bloco 12.5 — fix duplicidade):
//   1. Lê `phone` do `job.data` (acumulado pelo producer).
//   2. Chama `drainBucket(redis, phone)` para obter array de mensagens
//      consolidadas pelo debouncer rolling-window (Task #17).
//   3. Loga "processing job=... attempt=N consolidated=K" — evidência do
//      debounce funcionando.
//   4. Para garantir que cada `zapster_message_id` da janela vire 1 row
//      INBOUND (auditoria + idempotência contra retransmits do Zapster):
//        - Resolve contact + lead a partir do phone (mesmo helper do harness).
//        - Faz `claimMessage` em CADA uma das N-1 primeiras mensagens (a
//          última é deixada para o harness claim normal).
//        - Falhas individuais são logadas e seguem (best-effort).
//   5. Chama `harnessRun(lastPayload, lastHeaders)` UMA única vez. O L1
//      composer lê todas as user rows do contato em ordem cronológica e o
//      Anthropic SDK aceita user-messages consecutivos sem reclamar.
//
// Concurrency 5 + lockDuration 60s — espaço suficiente para o turno completo
// do harness (~15s típicos, com folga 4×).

import { Worker, type Job } from 'bullmq';

import { getRedis } from './connection';
import { drainBucket } from './debouncer';
import { QUEUE_NAME, type InboundJobData } from './producer';
import type { WebhookPayload } from '../edge/payload';
import type { RelevantHeaders } from './producer';
import { run as harnessRun } from '../harness/loop';
import { resolveContactFromPhone, normalizeE164 } from '../contacts/resolveContact';
import { resolveActiveLead } from '../contacts/resolveActiveLead';
import { claimMessage } from '../harness/idempotency';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export type MinimalLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** Forma de cada item retornado pelo `drainBucket` (mesmo shape pushed pelo producer). */
type DrainedMessage = {
  payload: WebhookPayload;
  headers: RelevantHeaders;
};

// ─────────────────────────────────────────────────────────────────────────────
// Processor
// ─────────────────────────────────────────────────────────────────────────────

function makeProcessor(logger: MinimalLogger) {
  return async function processor(job: Job<InboundJobData>): Promise<void> {
    const { phone } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

    // Smoke C: forçar fail por env var, sem tocar o código permanente.
    if (process.env.FORCE_FAIL === '1') {
      logger.warn(
        { jobId: job.id, attempt, FORCE_FAIL: true },
        'FORCE_FAIL=1 — throwing to test DLQ',
      );
      throw new Error('test fail');
    }

    let consolidated: DrainedMessage[] = [];
    try {
      consolidated = await drainBucket<DrainedMessage>(getRedis(), phone);
    } catch (err) {
      logger.error(
        {
          event: 'drain_bucket_failed',
          jobId: job.id,
          phone,
          err: err instanceof Error ? err.message : String(err),
        },
        'drainBucket failed',
      );
      // Re-throw para o BullMQ contar attempt e o DLQ handler agir após 3.
      throw err;
    }

    // Sentinel: se a LIST veio vazia (TTL estourou ou rotação rara), usar
    // pelo menos a mensagem que disparou o job (carregada no jobData).
    if (consolidated.length === 0) {
      logger.warn(
        {
          event: 'bucket_empty_using_sentinel',
          jobId: job.id,
          phone,
        },
        'bucket vazio — usando sentinel do jobData',
      );
      consolidated = [{ payload: job.data.payload, headers: job.data.headers }];
    }

    logger.info(
      {
        event: 'processing',
        jobId: job.id,
        phone,
        attempt,
        consolidated: consolidated.length,
        zapster_message_ids: consolidated
          .map((m) => m.payload.data.message.id)
          .filter(Boolean),
      },
      `processing job=${job.id} attempt=${attempt} consolidated=${consolidated.length}`,
    );

    // ── Pré-claim das mensagens 0..N-2 (Bloco 12.5 — fix duplicidade) ────
    //
    // Cada `zapster_message_id` precisa ter sua row INBOUND para:
    //   (a) integridade do histórico no L1 (Anthropic vê cada user msg);
    //   (b) idempotência contra retransmits do Zapster (UNIQUE constraint).
    //
    // A última (N-1) fica para o harness claim normalmente — ela vira a
    // mensagem "primária" que dispara este turno.
    const primary: DrainedMessage = consolidated[consolidated.length - 1];
    const earlies = consolidated.slice(0, -1);

    if (earlies.length > 0) {
      try {
        const normPhone = normalizeE164(phone);
        const contact = await resolveContactFromPhone(normPhone);
        const leadId = await resolveActiveLead(contact.contactId);

        let preclaimedNew = 0;
        let preclaimedDup = 0;
        for (const entry of earlies) {
          try {
            const result = await claimMessage(entry.payload, contact.contactId, leadId);
            if (result.isDuplicate) preclaimedDup += 1;
            else preclaimedNew += 1;
          } catch (err) {
            logger.warn(
              {
                event: 'preclaim_failed',
                zapster_message_id: entry.payload.data.message.id,
                err: err instanceof Error ? err.message : String(err),
              },
              'failed to pre-claim consolidated message — continuing',
            );
          }
        }

        logger.info(
          {
            event: 'consolidated_preclaimed',
            jobId: job.id,
            preclaimed_new: preclaimedNew,
            preclaimed_duplicate: preclaimedDup,
            primary_zapster_id: primary.payload.data.message.id,
          },
          `pre-claimed ${preclaimedNew} new + ${preclaimedDup} dup of ${earlies.length}`,
        );
      } catch (err) {
        // Se não conseguimos resolver contact, seguimos com harness na
        // primária mesmo assim — degraded mode (algumas msgs early ficam
        // sem row INBOUND, mas o turno responde algo ao usuário).
        logger.error(
          {
            event: 'consolidate_resolve_failed',
            jobId: job.id,
            phone,
            err: err instanceof Error ? err.message : String(err),
          },
          'failed to resolve contact for pre-claim — running harness on primary only',
        );
      }
    }

    // ── Harness — única chamada por job (turno consolidado) ──────────────
    const result = await harnessRun(primary.payload, primary.headers);
    logger.info(
      {
        event: 'harness_loop_result',
        jobId: job.id,
        status: result.status,
        turn_id: result.turnId,
        inbound_id: result.inboundMessageId,
        outbound_id: result.outboundMessageId,
        reason: result.reason,
      },
      `harness loop completed: ${result.status}`,
    );
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker singleton
// ─────────────────────────────────────────────────────────────────────────────

let cachedWorker: Worker<InboundJobData> | null = null;

/**
 * Sobe o consumer da queue `inbound`. Singleton — chamadas subsequentes
 * retornam o mesmo Worker.
 *
 * Concurrency 5 — múltiplos contatos em paralelo.
 * lockDuration 60s — turno harness completo cabe folgado (~15s típicos).
 */
export function startConsumer(logger: MinimalLogger): Worker<InboundJobData> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<InboundJobData>(QUEUE_NAME, makeProcessor(logger), {
    connection: getRedis(),
    concurrency: 5,
    lockDuration: 60_000,
  });

  cachedWorker.on('ready', () => {
    logger.info(
      { event: 'consumer_ready', queue: QUEUE_NAME, concurrency: 5 },
      'BullMQ consumer ready',
    );
  });

  return cachedWorker;
}

/** Fecha o consumer. Idempotente. Usado pelo graceful shutdown. */
export async function closeConsumer(): Promise<void> {
  if (!cachedWorker) return;
  try {
    await cachedWorker.close();
  } catch {
    // ignore
  } finally {
    cachedWorker = null;
  }
}
