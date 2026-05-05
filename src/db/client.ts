// src/db/client.ts
//
// Singleton do cliente Drizzle (read/write) para o worker.
// Usa postgres-js como driver subjacente, conectado ao Supabase via
// `env.DATABASE_URL` (validado por Zod em `src/env.ts`).
//
// `prepare: false` — o pooler do Supabase em transaction mode (port 6543) não
// suporta prepared statements PostgreSQL persistentes. Sem essa flag, queries
// quebram com erro "prepared statement already exists" após o pooler reciclar
// a conexão. Para session mode (port 5432) ou conexão direta, prepare pode ser
// true; deixamos false por padrão pra cobrir ambos.
//
// IMPORTANTE: o `schema` importado aqui é MANTIDO MANUALMENTE — `drizzle-kit
// pull` está bloqueado por bug em CHECK constraints (ver
// `docs/learn/drizzle-kit-pull-bug-checks.md`). Cada migration nova precisa
// de espelho em `schema.ts` no mesmo PR.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '../env';
import * as schema from './schema';

const sql = postgres(env.DATABASE_URL, {
  max: 10,
  prepare: false,
});

export const db = drizzle(sql, { schema });
export type DB = typeof db;

/**
 * Encerra a connection pool do postgres-js. Idempotente — após a primeira
 * chamada, novas chamadas a `db.*` falharão. Usar apenas em graceful shutdown.
 *
 * `timeout: 5` segundos: queries em andamento têm 5s para terminar antes de
 * serem interrompidas (alinhado com lockDuration do BullMQ Worker, 60s, e
 * com o ciclo de shutdown do servidor HTTP).
 */
export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
