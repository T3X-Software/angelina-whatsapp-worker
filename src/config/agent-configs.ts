// src/config/agent-configs.ts
//
// Bloco 11 — Tasks 54 + 55.
//
// Hot-reload de `agent_configs` via cache em memória com TTL 30s.
// Substitui o `findActiveByKeyInline` do `src/harness/loop.ts` (STUB B5).
//
// Padrão consolidado em `docs/concepts/hot-reload-config.md`:
//   - Lê via `findActiveByKey(key)`.
//   - Cacheia o resultado (incluindo `null`) por TTL fixo.
//   - Alteração no banco propaga em até TTL (default 30s) sem redeploy.
//
// Decisões (Bloco 11):
//   - Cacheia inclusive `null` para evitar thundering herd quando
//     `is_active=false` (flag off — caso default desta feature).
//   - Sem dedup de chamadas inflight (race aceita): a UNIQUE PARCIAL
//     `WHERE is_active=true` garante 0–1 row, query é rápida; cenário raro.
//   - TTL configurável via `AGENT_CONFIGS_CACHE_TTL_MS` (default 30000) — útil
//     para smokes; em prod, mantém 30s.
//   - `invalidate(key?)` exposto para hot-reload manual via CLI futura
//     (ex.: após UPDATE feito por humano para forçar re-leitura imediata).
//   - Logs `cache_hit`/`cache_miss` apenas em LOG_LEVEL=debug (silencioso em
//     info/warn).

import { and, eq } from 'drizzle-orm';
import pino from 'pino';

import { db } from '../db/client';
import { agentConfigs } from '../db/schema';
import type { AgentConfigRow } from '../harness/types';

const DEFAULT_TTL_MS = 30_000;

/** Lê o TTL no boot — não muda em runtime; smokes setam antes de importar. */
function readTtlMs(): number {
  const raw = process.env.AGENT_CONFIGS_CACHE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return n;
}

const TTL_MS = readTtlMs();

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

interface CacheEntry {
  value: AgentConfigRow | null;
  expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

/**
 * Busca a row ativa de `agent_configs` por `key`.
 *
 * Cacheia o resultado (inclusive `null`) por `TTL_MS`. Cache hit retorna
 * imediato sem ir ao banco. Cache miss faz `SELECT ... WHERE key=$1 AND
 * is_active=true LIMIT 1` (a UNIQUE PARCIAL garante 0 ou 1 row).
 *
 * Retorna `null` quando não há row ativa (feature flag off, agent inativo).
 */
export async function findActiveByKey(
  key: string,
): Promise<AgentConfigRow | null> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    if (logger.isLevelEnabled('debug')) {
      logger.debug({ event: 'agent_configs.cache_hit', key }, 'cache hit');
    }
    return cached.value;
  }

  if (logger.isLevelEnabled('debug')) {
    logger.debug({ event: 'agent_configs.cache_miss', key }, 'cache miss');
  }

  const rows = await db
    .select()
    .from(agentConfigs)
    .where(and(eq(agentConfigs.key, key), eq(agentConfigs.isActive, true)))
    .limit(1);

  const value: AgentConfigRow | null = rows.length > 0 ? rows[0] : null;
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

/**
 * Limpa o cache. Sem `key`, limpa tudo (útil em testes).
 *
 * Uso esperado: hot-reload manual via CLI futura após UPDATE no banco
 * que precisa propagar antes do TTL natural (raro).
 */
export function invalidate(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/**
 * Internals expostos APENAS para smokes/tests inspecionarem o estado do cache.
 *
 * NÃO usar em código de produção — não há contrato de estabilidade.
 */
export const _internals = {
  cache,
  ttlMs: TTL_MS,
};
