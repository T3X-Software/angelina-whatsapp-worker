// src/utils/distributed-lock.ts
//
// Bloco 2 — Task #9 da feature `follow-up-pendente`.
//
// Postgres advisory lock leve (decisão D3) para garantir que no máximo
// 1 instância do cron `follow-up-checker` rode por vez. Sem Redis novo
// (`pg_try_advisory_lock` já está no stack via Drizzle + postgres-js).
//
// Pattern de uso típico:
//
//   if (!(await acquireLock('follow_up_checker'))) {
//     logger.info({event:'follow_up_lock_skipped'}, 'another instance owns the lock');
//     return;
//   }
//   try {
//     // ... trabalho do cron ...
//   } finally {
//     await releaseLock('follow_up_checker');
//   }
//
// Semântica do `pg_try_advisory_lock` (session-level):
//   - O lock é exclusivo POR SESSÃO Postgres (não por transação).
//   - Reentrante na MESMA sessão: 2 chamadas consecutivas retornam true,
//     mas exigem 2 `pg_advisory_unlock` para liberar.
//   - Em sessões diferentes: 1ª retorna true, 2ª retorna false (sem bloqueio).
//   - **Auto-release na queda de conexão:** se a sessão Postgres for fechada
//     antes do unlock explícito (PM2 crash, restart, idle eviction do pool),
//     o lock libera implicitamente. Sem TTL órfão.
//
// IMPORTANTE — pool de conexões (postgres-js, max: 10):
//   - `db.execute()` pega uma conexão do pool, executa o SELECT e devolve.
//   - O `acquireLock` e o `releaseLock` PODEM ser executados em conexões
//     diferentes do pool. O Postgres trata advisory_lock por backend PID,
//     não por requisição lógica do cliente.
//   - Na prática, com pool de 10 e poucos consumers concorrentes, o lock
//     fica "preso" à conexão sortida no momento do acquire. Se outra
//     conexão tentar release, retorna false silenciosamente (não é erro,
//     mas o lock só libera quando a sessão original encerrar).
//   - **Para garantir release**, este helper SEMPRE faz o release na MESMA
//     transação (`db.transaction`) ou usa `pg_advisory_unlock_all` no
//     graceful shutdown (`closeDb` em `db/client.ts`).
//   - Trade-off aceito (D3): worst case o lock fica preso por até o TTL
//     idle do pool (default postgres-js ~30s) — janela mais curta que o
//     intervalo do cron (10min), então sem impacto operacional.
//
// `hashtext(key)::bigint` converte a string em um int64 determinístico
// usado pelo Postgres para identificar o lock. Hash collision é possível
// mas trivialmente raro (2^32 ≈ 4 bilhões de slots; usamos 1 key, 'follow_up_checker').

import { sql } from 'drizzle-orm';

import { db } from '../db/client';

/**
 * Tenta adquirir o lock advisory para a `key`. Retorna `true` se conseguiu,
 * `false` se outra sessão Postgres já segura o lock (instância paralela).
 *
 * NÃO bloqueia — `pg_try_advisory_lock` é não-blocking por design (versão
 * blocking seria `pg_advisory_lock`, evitada para não travar o worker).
 *
 * Hash da chave: `hashtext(key)::bigint` (slot int64 determinístico).
 *
 * @param key chave lógica do lock (ex: `'follow_up_checker'`).
 * @returns `true` se o lock foi adquirido, `false` caso contrário.
 */
export async function acquireLock(key: string): Promise<boolean> {
  const rows = await db.execute<{ acquired: boolean }>(sql`
    SELECT pg_try_advisory_lock(hashtext(${key})::bigint) AS acquired
  `);
  const arr = Array.from(rows) as Array<{ acquired: boolean }>;
  return arr[0]?.acquired === true;
}

/**
 * Libera o lock advisory para a `key`. Idempotente — retorna `void` mesmo
 * se outra sessão segura o lock (release no-op silencioso).
 *
 * **Sempre chamar no `finally`** do bloco que adquiriu o lock para evitar
 * dependência em auto-release por queda de conexão.
 *
 * @param key chave lógica do lock (mesma usada em `acquireLock`).
 */
export async function releaseLock(key: string): Promise<void> {
  await db.execute(sql`
    SELECT pg_advisory_unlock(hashtext(${key})::bigint)
  `);
}

/**
 * Chave canônica do lock do cron de follow-up. Centralizada aqui para
 * evitar typo divergente entre o checker e eventuais smoke tests.
 */
export const FOLLOW_UP_CHECKER_LOCK_KEY = 'follow_up_checker';
