// src/queue/connection.ts
//
// Singleton ioredis usado por todos os componentes do Bloco 3 (producer,
// debouncer, consumer, dlq-handler). Configuração obrigatória:
//   - maxRetriesPerRequest: null   → exigência do BullMQ Worker (sem isso
//                                    BullMQ joga warning fatal). Ver
//                                    https://docs.bullmq.io/guide/connections
//   - enableReadyCheck: true       → garante PONG antes de aceitar comandos
//   - lazyConnect: false           → conecta no momento da instância;
//                                    `validateRedis()` no boot só faz ping
//                                    extra para falhar rápido se inacessível
//
// O singleton é criado na 1ª chamada de `getRedis()` e cacheado no módulo.
// `closeRedis()` é usado pelo graceful shutdown do main.ts.

import IORedis, { type Redis as IORedisInstance } from 'ioredis';

import { env } from '../env';

// Tipo do logger compatível com pino e FastifyBaseLogger (mesmo padrão do producer).
type MinimalLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

let cached: IORedisInstance | null = null;

/**
 * Retorna a instância singleton de ioredis. Cria na 1ª chamada usando
 * `env.REDIS_URL`. Configuração obrigatória para BullMQ Worker.
 */
export function getRedis(): IORedisInstance {
  if (cached) return cached;

  cached = new IORedis(env.REDIS_URL, {
    // CRÍTICO: BullMQ Worker exige `null` aqui. Caso contrário, dispara
    // o warning "Eviction policy is noeviction. It is required to use
    // `maxRetriesPerRequest=null`" e o consumer não processa nada.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  // Loga error events para evitar "Unhandled error event" do ioredis.
  // Reconexões são automáticas (default retryStrategy do ioredis).
  cached.on('error', (err) => {
    // Sem logger aqui (singleton sem injeção). Usamos console.error em último
    // caso — em prática, validateRedis e o BullMQ já capturam erros relevantes.
    // eslint-disable-next-line no-console
    console.error('[redis] error event:', err.message);
  });

  return cached;
}

/**
 * Faz `PING` no boot. Se a resposta ≠ PONG, lança erro com mensagem clara
 * apontando o REDIS_URL configurado (sem credenciais — só host:port).
 *
 * Chamado em main.ts antes de subir Fastify para falhar rápido se Redis
 * não estiver disponível (Bloco 3+ exige Redis ativo, ao contrário do
 * Bloco 0 que tolerava ausência).
 */
export async function validateRedis(logger: MinimalLogger): Promise<void> {
  const redis = getRedis();

  try {
    const pong = await redis.ping();
    if (pong !== 'PONG') {
      throw new Error(`Resposta inesperada de PING: ${pong}`);
    }
    logger.info({ event: 'redis_validated' }, 'Redis OK (PING → PONG)');
  } catch (err) {
    const safeUrl = redactRedisUrl(env.REDIS_URL);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Redis indisponível em ${safeUrl}: ${msg}. ` +
        'Bloco 3+ exige Redis ativo. ' +
        'Em dev, suba o container `lua-redis-test` (docker run -d --name lua-redis-test -p 6380:6379 redis:7-alpine).',
    );
  }
}

/**
 * Fecha a conexão do singleton. Idempotente. Usado pelo graceful shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (!cached) return;
  try {
    await cached.quit();
  } catch {
    // ignore — quit pode falhar se já desconectado; não faz mal
  } finally {
    cached = null;
  }
}

/** Remove credenciais de uma redis:// URL para log seguro. */
function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '<invalid-url>';
  }
}
