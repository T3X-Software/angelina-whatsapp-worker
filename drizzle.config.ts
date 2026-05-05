// drizzle.config.ts
//
// Configuração do drizzle-kit para o worker. Usado APENAS para `db:pull`
// (read-only do schema). NUNCA rodar `drizzle-kit generate`, `drizzle-kit push`
// ou qualquer comando que escreva no banco — fonte da verdade do schema é o
// Supabase, em `plataforma web/espacoangelinos/supabase/migrations/`.
//
// `db:pull` lê o estado atual do banco e regenera:
//   - src/db/schema.ts    — definições de tabela em TS
//   - src/db/relations.ts — relações entre tabelas
//
// Ambos os arquivos são gerados — não editar manualmente.

import 'dotenv/config';
import type { Config } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill the value.'
  );
}

export default {
  out: './src/db',
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Apenas tabelas do schema public da harness — o worker NÃO precisa
  // de tipos para o CRM (web tem types/supabase.ts pra isso). Restringir
  // via tablesFilter também contorna um bug do drizzle-kit 0.31.10 que
  // quebra ao introspectar certos CHECK constraints do CRM
  // (TypeError: Cannot read properties of undefined (reading 'replace')
  // em bin.cjs:17861, na fase de "check constraints fetching").
  schemaFilter: ['public'],
  tablesFilter: [
    'messages',
    'agent_configs',
    'contact_facts',
    'traces',
    'knowledge_articles',
  ],
} satisfies Config;
