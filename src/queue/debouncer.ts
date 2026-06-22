// src/queue/debouncer.ts
//
// Debounce per-contact via Redis. Estratégia: LIST per-phone + jobId-único-por-mensagem.
//
//  - LIST `lua:debounce:{phone}` acumula payloads de webhooks daquele contato
//    via `appendToBucket(phone)` (RPUSH + PEXPIRE 10s).
//  - Cada webhook gera 1 job BullMQ próprio (jobId atrelado ao
//    `zapster_message_id` no producer — ver `producer.ts`).
//  - Todos os jobs daquele contato são `delay = bucket_ms` (configurável,
//    default ~2.5s — Feature A 1.1).
//  - Quando o PRIMEIRO job dispara, o consumer chama `drainBucket(phone)`
//    e drena a LIST inteira de uma vez — todos os payloads acumulados
//    durante a janela viram UM turno consolidado.
//  - Os jobs irmãos do mesmo burst chegam ms depois, encontram a LIST vazia
//    e o sentinel cai em `claimMessage` que detecta duplicata
//    (zapster_message_id já claimado pelo pre-claim do primeiro job) →
//    `duplicate_skipped`. Sem segunda resposta.
//
// Decisão registrada (Bloco 12.5 — segunda iteração do fix de duplicidade,
// 2026-05-04): a estratégia anterior (rolling window via `Job.changeDelay`)
// funcionava enquanto o job estava em delayed/waiting, mas o jobId per-phone
// ficava queimado no set `completed` depois que o consumer terminava — novos
// webhooks deduplicavam contra o job velho e nunca rodavam. jobId-único-por-
// mensagem + drain compartilhado evita esse buraco mantendo a consolidação.
//
// Não chama LLM, não toca banco — só Redis.

import type { Redis as IORedisInstance } from 'ioredis';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes públicas
// ─────────────────────────────────────────────────────────────────────────────

/** Janela de silêncio (ms) DEFAULT — usada quando
 *  `hook_params.debounce.bucket_ms` está ausente/inválido. */
export const DEFAULT_BUCKET_MS = 2500;

/** Piso do TTL da LIST Redis (ms). O TTL real é `max(4× bucket, este piso)`,
 *  garantindo folga para o drain mesmo com bucket pequeno. */
export const MIN_BUCKET_TTL_MS = 10_000;

/** TTL default da LIST quando `appendToBucket` é chamado sem `ttlMs` explícito. */
export const defaultBucketTtlMs = MIN_BUCKET_TTL_MS;

/**
 * Feature A (1.1) — resolve `bucket_ms` vindo da config (JSONB, pode vir
 * malformado). Default seguro 2500; ignora não-número ou ≤0.
 */
export function resolveBucketMs(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_BUCKET_MS;
}

/**
 * Feature A (1.1) — TTL da LIST derivado do bucket: `max(4× bucket, piso 10s)`.
 * Preserva a invariante "TTL >> janela de consolidação" mesmo se o bucket subir.
 */
export function deriveBucketTtlMs(bucketMs: number): number {
  return Math.max(4 * bucketMs, MIN_BUCKET_TTL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de chave
// ─────────────────────────────────────────────────────────────────────────────

/** Chave da LIST Redis que acumula os payloads do contato (consumida no drain). */
export function consolidateRedisKey(phone: string): string {
  return `lua:debounce:${phone}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operações
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acumula um payload na LIST do contato. Usa pipeline RPUSH+PEXPIRE.
 * Não retorna o tamanho (não é necessário — o consumer faz drain completo).
 */
export async function appendToBucket(
  redis: IORedisInstance,
  phone: string,
  msgPayload: unknown,
  ttlMs: number = defaultBucketTtlMs,
): Promise<void> {
  const key = consolidateRedisKey(phone);
  const json = JSON.stringify(msgPayload);

  await redis
    .pipeline()
    .rpush(key, json)
    .pexpire(key, ttlMs)
    .exec();
}

/**
 * Drena a LIST completa do contato (LRANGE 0 -1 + DEL atomicamente via pipeline).
 * Retorna o array de payloads parsed (cada item foi pushed por `appendToBucket`).
 *
 * Se a LIST não existe ou está vazia, retorna []. O consumer deve tolerar
 * isso (pode acontecer se `appendToBucket` falhou silenciosamente OU se o
 * job foi disparado por outra via).
 */
export async function drainBucket<T = unknown>(
  redis: IORedisInstance,
  phone: string,
): Promise<T[]> {
  const key = consolidateRedisKey(phone);

  const result = await redis
    .pipeline()
    .lrange(key, 0, -1)
    .del(key)
    .exec();

  if (!result) return [];

  // pipeline.exec() retorna array de [err, value] tuples.
  const lrangeResult = result[0];
  if (!lrangeResult) return [];
  const [lrangeErr, items] = lrangeResult;
  if (lrangeErr) throw lrangeErr;

  if (!Array.isArray(items)) return [];

  const parsed: T[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    try {
      parsed.push(JSON.parse(raw) as T);
    } catch {
      // Item corrompido — ignora silenciosamente. Em prod, logar via tracer
      // do consumer. Não bloqueamos o turno por causa de 1 mensagem ruim.
    }
  }

  return parsed;
}
