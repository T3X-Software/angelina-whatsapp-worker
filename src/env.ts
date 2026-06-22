// src/env.ts
//
// Carregador de variáveis de ambiente com validação via Zod.
// Falha rápido (throw) no boot se algo essencial estiver faltando ou mal-formado.
//
// Padrão: importar `env` de qualquer lugar — `import { env } from './env'`.
// O loader executa uma única vez (top-level), e o objeto resultante é imutável.
//
// IMPORTANTE: nunca acessar `process.env.X` diretamente fora deste arquivo.
// Tudo deve passar pelo schema validado abaixo.

import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  // Banco — Supabase Postgres via pooler em transaction mode (port 6543).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),

  // Redis — usado por BullMQ (queue) e por debouncer (per-contact buckets).
  REDIS_URL: z.string().min(1, 'REDIS_URL é obrigatório'),

  // Anthropic — chave do Claude (modelo principal da Angelina).
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY é obrigatório'),

  // Zapster — gateway WhatsApp (não é Meta Cloud API).
  ZAPSTER_API_URL: z.string().url('ZAPSTER_API_URL deve ser uma URL válida'),
  ZAPSTER_API_KEY: z.string().min(1, 'ZAPSTER_API_KEY é obrigatório'),
  ZAPSTER_INSTANCE_ID: z.string().min(1, 'ZAPSTER_INSTANCE_ID é obrigatório'),
  ZAPSTER_WEBHOOK_ID: z.string().min(1, 'ZAPSTER_WEBHOOK_ID é obrigatório'),

  // Token aleatório embutido no path do webhook — primeira camada de auth (404).
  // Gerado uma vez e cadastrado no painel Zapster + .env.production do VPS.
  ZAPSTER_WEBHOOK_TOKEN: z.string().min(16, 'ZAPSTER_WEBHOOK_TOKEN deve ter ≥16 chars'),

  // HTTP server (Fastify) — porta do edge handler.
  // Mantém o nome LUA_HTTP_PORT por consistência histórica com o material LEGADO,
  // mesmo que a persona ativa em prod seja "Angelina".
  LUA_HTTP_PORT: z
    .string()
    .default('3001')
    .transform((s) => Number.parseInt(s, 10))
    .pipe(z.number().int().positive().max(65535)),

  // Log level do pino. Em prod, normalmente 'info'; em dev, 'debug'.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Secret bearer da rota interna POST /internal/insights/run (analista
  // on-demand disparado pelo app web). OPCIONAL: se ausente, o endpoint
  // on-demand fica desabilitado (503) — o cron do analista segue funcionando.
  // Deve casar com INSIGHTS_TRIGGER_SECRET do app web.
  INSIGHTS_TRIGGER_SECRET: z
    .string()
    .min(16, 'INSIGHTS_TRIGGER_SECRET deve ter ≥16 chars')
    .optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Mensagem clara em stderr antes do throw — facilita o diagnóstico em logs do VPS.
    // eslint-disable-next-line no-console
    console.error(
      `[env.ts] Falha ao carregar variáveis de ambiente:\n${issues}\n\n` +
        'Verifique o .env (dev) ou o .env.production (VPS) e tente novamente.',
    );
    throw new Error('Invalid environment configuration');
  }

  return parsed.data;
}

export const env: Env = loadEnv();
