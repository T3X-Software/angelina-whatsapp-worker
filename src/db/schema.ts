// src/db/schema.ts
//
// Schema Drizzle do worker — fonte da verdade da TIPAGEM em TS.
// **NORMALMENTE este arquivo seria gerado por `npm run db:pull`** a partir
// do banco Supabase. Em 2026-05-02 (Bloco 6 da feature `harness-schema-foundation`)
// descobrimos que `drizzle-kit pull` tem um bug determinístico ao introspectar
// nossos CHECK constraints (`TypeError: Cannot read properties of undefined
// (reading 'replace')` em `bin.cjs:19401` no 0.30.6 / `:17861` no 0.31.10 —
// fase "check constraints fetching"). Reproduz mesmo restringindo `tablesFilter`
// só para as 5 tabelas da harness. Documentado em
// `docs/learn/drizzle-kit-pull-bug-checks.md`.
//
// Workaround vigente: este arquivo é mantido MANUALMENTE para refletir o
// estado real do banco, conforme as migrations em
// `plataforma web/espacoangelinos/supabase/migrations/`. Cada migration nova
// que altere o schema **deve** atualizar este arquivo no mesmo PR — sem
// regenerar via comando, drift é o risco. Quando o bug for corrigido (ou
// quando aparecer um flag `--skip-check-constraints`), substituir por versão
// pulled e diffar.
//
// CHECKs e triggers são definidos no DB (migrations) e NÃO são modelados aqui
// porque o Drizzle não precisa deles em TS — o Postgres enforça em runtime.
//
// Histórico de extensões manuais (append-only):
//   - 2026-05-02 (harness-schema-foundation, Bloco 6) — 5 tabelas iniciais
//     (messages, agent_configs, contact_facts, traces, knowledge_articles)
//     + stubs `contacts`/`leads` só com `id` para satisfazer FKs.
//   - 2026-05-02 (harness-worker-inbound, Bloco 4 — Task 21) — colunas
//     mínimas em `contacts` e `leads` necessárias para resolveContact/Lead/
//     updateLastActivity, + tabelas novas `contact_phones`, `tasks`,
//     `timeline_events`, `pipeline_columns` (também só colunas mínimas
//     usadas pela harness; CRM web tem `types/supabase.ts` para o resto),
//     + enums correspondentes do CRM (lead_score, lead_status_enum,
//     event_type, task_type, task_status, task_priority,
//     timeline_event_type, pipeline_column_type).
//   - 2026-05-17 (follow-up-pendente, Bloco 1 — Task #8) — adicionada coluna
//     `leads.followUpDisabled` (boolean NOT NULL default false) + tabela nova
//     `follow_up_attempts` (histórico de tentativas de follow-up automático
//     com responded_at preenchido pelo response-tracker). Migration:
//     20260517100000_follow_up_pipeline.sql.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// =====================================================================
// Enums
// =====================================================================

// — Harness (criados pelas migrations da feature anterior) —

export const messageDirection = pgEnum('message_direction', [
  'INBOUND',
  'OUTBOUND',
]);

export const messageRole = pgEnum('message_role', [
  'user',
  'assistant',
  'system',
  'tool',
]);

export const messageSendStatus = pgEnum('message_send_status', [
  'pending',
  'sending',
  'sent',
  'failed',
]);

// — CRM (criados pelas migrations originais do app web; o worker só lê/usa) —
//
// pgEnum aqui declara o TIPO ao Drizzle (não cria o enum no banco — o banco
// já tem). Os literais devem casar EXATAMENTE com os do banco; divergência
// causa erro em runtime.

export const leadScore = pgEnum('lead_score', ['HOT', 'WARM', 'COLD']);

export const leadStatusEnum = pgEnum('lead_status_enum', [
  'OPEN',
  'WON',
  'LOST',
]);

export const eventType = pgEnum('event_type', [
  'WEDDING',
  'BIRTHDAY',
  'CORPORATE',
  'GRADUATION',
  'SWEET_FIFTEEN',
  'OTHER',
]);

export const taskType = pgEnum('task_type', [
  'TASK',
  'APPOINTMENT',
  'FOLLOWUP',
  'CALL',
  'EMAIL',
  'VISIT',
  'PROPOSAL',
  'CONTRACT',
  'PAYMENT',
  'DELIVERY',
]);

export const taskStatus = pgEnum('task_status', [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'ARCHIVED',
]);

export const taskPriority = pgEnum('task_priority', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
]);

export const timelineEventType = pgEnum('timeline_event_type', [
  'LEAD_CREATED',
  'LEAD_UPDATED',
  'STAGE_CHANGED',
  'TASK_CREATED',
  'TASK_COMPLETED',
  'NOTE_ADDED',
  'CALL_MADE',
  'EMAIL_SENT',
  'VISIT_SCHEDULED',
  'VISIT_COMPLETED',
  'PROPOSAL_SENT',
  'PROPOSAL_ACCEPTED',
  'CONTRACT_SIGNED',
  'PAYMENT_RECEIVED',
  'EVENT_COMPLETED',
  'OTHER',
]);

export const pipelineColumnType = pgEnum('pipeline_column_type', [
  'ENTRY',
  'WON',
  'LOST',
  'CUSTOM',
]);

// =====================================================================
// CRM — colunas mínimas (Bloco 4)
//
// Apenas as colunas que `resolveContact / resolveActiveLead /
// updateLastActivity` (e hooks/tools posteriores: transfer-trigger Bloco 6,
// save-lead-info / classify-lead Bloco 7) precisam tipadas. O CRM web tem
// `types/supabase.ts` com o shape completo — **não duplicar** aqui.
//
// `ai_state` é text com CHECK no banco (['AUTO','PAUSED','HUMAN_TAKEOVER',
// 'AFTER_HOURS_OK']); modelado como text porque o CHECK não justifica enum
// dedicado e seria gerar atrito com o app web que escreve o mesmo campo.
// =====================================================================

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  origin: text('origin'),
  aiState: text('ai_state').notNull().default('AUTO'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const contactPhones = pgTable('contact_phones', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  phone: text('phone').notNull(),
  type: text('type').default('mobile'),
  isPrimary: boolean('is_primary').default(false),
  isWhatsapp: boolean('is_whatsapp').default(true),
});

export const pipelineColumns = pgTable('pipeline_columns', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: pipelineColumnType('type').notNull().default('CUSTOM'),
  name: text('name').notNull(),
});

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  pipelineColumnId: uuid('pipeline_column_id')
    .notNull()
    .references(() => pipelineColumns.id),
  assignedToId: uuid('assigned_to_id'),
  origin: text('origin'),
  classification: leadScore('classification').notNull().default('COLD'),
  eventType: eventType('event_type'),
  eventDate: date('event_date'),
  guestCount: integer('guest_count'),
  estimatedBudget: numeric('estimated_budget'),
  status: leadStatusEnum('status').default('OPEN'),
  isHumanActive: boolean('is_human_active').notNull().default(false),
  // Migration 20260509000000_handoff_continuity (feature
  // whatsapp-message-splitting-and-handoff-continuity, Bloco 1).
  // 3 estados de is_human_active via handoff_assumed_at:
  //   isHumanActive=false                      → modo normal (IA livre).
  //   isHumanActive=true && assumedAt IS NULL  → handoff disparado, modo
  //                                              assistido (IA continua com
  //                                              restrições do response-guard).
  //   isHumanActive=true && assumedAt NOT NULL → humano assumiu, IA fica 100%
  //                                              muda. Setado por webhook
  //                                              detection ou /assumi <lead_id>.
  handoffAssumedAt: timestamp('handoff_assumed_at', { withTimezone: true }),
  // Snapshot do interesse do lead no momento do handoff. Gerado pelo Claude
  // e passado como argumento da tool transfer_to_human (Bloco 3).
  interestSummary: text('interest_summary'),
  // Snapshot da ação sugerida ao operador no momento do handoff. Gerado pelo
  // Claude e passado como argumento da tool transfer_to_human (Bloco 3).
  // Usado para preencher {{acao_sugerida}} no template handoff_support_message_template.
  suggestedAction: text('suggested_action'),
  // Migration 20260517100000_follow_up_pipeline (feature follow-up-pendente).
  // Desativa follow-ups automáticos para este lead. Setado true pela escalação
  // automática (RF5) após 2 tentativas sem resposta. Reativar via comando admin
  // /reativar-followup <phone> ou UPDATE manual. NÃO confundir com
  // contacts.ai_state (manual): este é controle AUTOMÁTICO da harness.
  followUpDisabled: boolean('follow_up_disabled').notNull().default(false),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contacts.id, {
    onDelete: 'set null',
  }),
  title: text('title').notNull(),
  type: taskType('type').notNull().default('TASK'),
  status: taskStatus('status').notNull().default('PENDING'),
  priority: taskPriority('priority').notNull().default('MEDIUM'),
  assignedToId: uuid('assigned_to_id'),
  // Migration 20260509000000_handoff_continuity (feature
  // whatsapp-message-splitting-and-handoff-continuity, Bloco 1).
  // Phone do support_whatsapp atribuído à task. Denormalizado para hot-path do
  // webhook handler (Bloco 9) que vincula inbound→lead sem JOIN com users.
  // Convenção de format: sem '+', igual Zapster (ex 5519974131955).
  assignedToPhone: text('assigned_to_phone'),
  createdById: uuid('created_by_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const timelineEvents = pgTable('timeline_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  type: timelineEventType('type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  metadata: jsonb('metadata'),
  createdById: uuid('created_by_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// =====================================================================
// messages
// =====================================================================

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    direction: messageDirection('direction').notNull(),
    zapsterMessageId: text('zapster_message_id'),
    zapsterInstanceId: text('zapster_instance_id'),
    recipientId: text('recipient_id'),
    recipientType: text('recipient_type'),
    text: text('text'),
    mediaUrl: text('media_url'),
    mediaType: text('media_type'),
    transcription: text('transcription'),
    role: messageRole('role').notNull(),
    toolName: text('tool_name'),
    toolArgs: jsonb('tool_args'),
    toolResult: jsonb('tool_result'),
    // FK self-reference: row de tool_result aponta para a row de tool_use que a originou.
    // Migration 20260503210000_add_tool_use_message_id (harness-worker-inbound, fix bug #5).
    toolUseMessageId: uuid('tool_use_message_id').references(
      (): AnyPgColumn => messages.id,
      { onDelete: 'set null' },
    ),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    sendStatus: messageSendStatus('send_status'),
    sendAttempts: smallint('send_attempts').notNull().default(0),
    sendAttemptedAt: timestamp('send_attempted_at', { withTimezone: true }),
    zapsterAttemptCount: integer('zapster_attempt_count'),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('messages_contact_created_idx').on(t.contactId, t.createdAt.desc()),
    uniqueIndex('messages_zapster_message_id_uidx')
      .on(t.zapsterMessageId)
      .where(sql`${t.zapsterMessageId} IS NOT NULL`),
    index('messages_outbound_pending_idx')
      .on(t.createdAt)
      .where(sql`direction = 'OUTBOUND' AND send_status = 'pending'`),
    index('messages_outbound_failed_idx')
      .on(t.createdAt)
      .where(sql`direction = 'OUTBOUND' AND send_status = 'failed'`),
    index('messages_tool_use_message_id_idx')
      .on(t.toolUseMessageId)
      .where(sql`tool_use_message_id IS NOT NULL`),
  ],
);

// =====================================================================
// agent_configs
// =====================================================================

export const agentConfigs = pgTable(
  'agent_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    version: integer('version').notNull().default(1),
    systemPrompt: text('system_prompt').notNull().default(''),
    model: text('model').notNull().default('claude-sonnet-4-6'),
    temperature: numeric('temperature', { precision: 3, scale: 2 })
      .notNull()
      .default('0.4'),
    maxIterations: smallint('max_iterations').notNull().default(5),
    toolsEnabled: text('tools_enabled')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    fallbackProvider: text('fallback_provider').notNull().default('openai'),
    fallbackModel: text('fallback_model').notNull().default('gpt-4o'),
    fallbackMessage: text('fallback_message').notNull().default(''),
    supportWhatsapp: text('support_whatsapp').notNull().default(''),
    hookParams: jsonb('hook_params')
      .notNull()
      .default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('agent_configs_key_version_unique').on(t.key, t.version),
    uniqueIndex('agent_configs_one_active_per_key_uidx')
      .on(t.key)
      .where(sql`is_active = true`),
  ],
);

// =====================================================================
// contact_facts
// =====================================================================

export const contactFacts = pgTable(
  'contact_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    factType: text('fact_type').notNull(),
    factValue: jsonb('fact_value').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 })
      .notNull()
      .default('0.5'),
    source: text('source'),
    sourceMsgId: uuid('source_msg_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    extractedAt: timestamp('extracted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references(
      (): AnyPgColumn => contactFacts.id,
      { onDelete: 'set null' },
    ),
  },
  (t) => [
    index('contact_facts_contact_type_idx').on(t.contactId, t.factType),
    index('contact_facts_active_high_conf_idx')
      .on(t.contactId, t.confidence.desc())
      .where(sql`superseded_by IS NULL`),
  ],
);

// =====================================================================
// traces
// =====================================================================

export const traces = pgTable(
  'traces',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    eventType: text('event_type').notNull(),
    messageId: uuid('message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    phase: text('phase'),
    hookName: text('hook_name'),
    toolName: text('tool_name'),
    latencyMs: integer('latency_ms'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('traces_message_id_idx').on(t.messageId),
    index('traces_contact_created_idx').on(t.contactId, t.createdAt.desc()),
    index('traces_event_type_created_idx').on(
      t.eventType,
      t.createdAt.desc(),
    ),
  ],
);

// =====================================================================
// knowledge_articles
// =====================================================================

export const knowledgeArticles = pgTable('knowledge_articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  category: text('category'),
  embedding: vector('embedding', { dimensions: 1536 }),
  published: boolean('published').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// =====================================================================
// follow_up_attempts
// =====================================================================
//
// Migration 20260517100000_follow_up_pipeline (feature follow-up-pendente).
// Histórico de tentativas de follow-up automático por contato. attempt_number
// conta tentativas na janela móvel de 24h (max_attempts_per_24h em hook_params).
// responded_at é preenchido pelo response-tracker (cron secundário) quando o
// cliente responde após o envio do follow-up; response_time_minutes derivado.

export const followUpAttempts = pgTable(
  'follow_up_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    attemptNumber: integer('attempt_number').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    templateUsed: text('template_used'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    responseTimeMinutes: integer('response_time_minutes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index('idx_follow_up_attempts_contact').on(t.contactId, t.sentAt.desc()),
    // idx_follow_up_attempts_unresponded é parcial (WHERE responded_at IS NULL)
    // — declarado na migration; Drizzle não modela WHERE em index() helper.
  ],
);
