// src/config/types.ts
//
// Bloco 1 — Task 5 da feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Tipos compartilhados para os 5 sub-objetos novos de `agent_configs.hook_params`
// introduzidos pela migration `20260509000000_handoff_continuity.sql`.
//
// **Convenção do projeto:** cada hook costuma declarar um `HookParamsShape`
// local restrito apenas às chaves que aquele hook consome (ver
// `rate-limit-guard.ts`, `admin-router.ts`, `transfer-trigger.ts`). Este
// arquivo NÃO substitui esse padrão — apenas centraliza os 3 sub-objetos
// estruturados (splitter + assisted_mode + template handoff) que serão
// consumidos por múltiplos hooks/utils nos Blocos 2-9 (format-whatsapp,
// transfer-trigger, response-guard, load-context).
//
// Forma JSON correspondente em `agent_configs.hook_params` (v3 da chave
// `angelina`, conforme migration acima).
//
// Decisões aprovadas em 2026-05-09 (D4): 5 campos novos como subkeys de
// `hook_params`, sem ALTER em `agent_configs`. Veja
// `docs/features/whatsapp-message-splitting-and-handoff-continuity/implementation-log.md`.

/**
 * Splitter de mensagens longas (`format-whatsapp` AFTER_MODEL — Bloco 2).
 *
 * Mensagens > `softLimit` chars são divididas em até `maxParts` partes,
 * priorizando quebra por `\n\n` e sub-dividindo por `. ` se uma parte
 * ainda exceder `hardLimit`. `intervalMs` é o atraso entre envios
 * sucessivos no BEFORE_SEND iterado.
 *
 * Default v3 (migration 20260509000000):
 *   { soft_limit: 800, hard_limit: 1200, max_parts: 4, interval_ms: 1500 }
 */
export interface MessageSplitConfig {
  soft_limit: number;
  hard_limit: number;
  max_parts: number;
  interval_ms: number;
}

/**
 * Categoria do classifier do response-guard em modo assistido (Bloco 5).
 *
 * `patterns` é uma lista de regex em FORMA STRING, compiladas para `RegExp`
 * no boot do hook (cache module-level — invalidação acoplada ao TTL do
 * cache de `agent_configs`, 30s).
 *
 * **Importante:** patterns aqui são tratados como regex já com flags
 * `iu` ao serem compilados (case-insensitive + Unicode). Não use `^` ou
 * `$` para limitar à mensagem inteira — eles atuam dentro de cada match.
 */
export interface AssistedModeClassifierCategory {
  patterns: string[];
}

/**
 * Conjunto das 3 sub-categorias do classifier (Bloco 5).
 *
 * Precedência ao avaliar a saída do LLM em modo assistido:
 *   `duplicate_handoff` > `monetary` > `booking`
 *
 * Primeira categoria que matchar substitui a resposta pelo redirect
 * correspondente em `AssistedModeRedirectMessages`. Se nenhuma matchar,
 * a resposta passa intacta.
 */
export interface AssistedModeClassifier {
  monetary: AssistedModeClassifierCategory;
  booking: AssistedModeClassifierCategory;
  duplicate_handoff: AssistedModeClassifierCategory;
}

/**
 * Mensagens de redirecionamento por categoria do classifier (Bloco 5).
 *
 * `null` em `duplicate_handoff` significa "não envia nada" — apenas
 * descarta a mensagem (evita o cliente receber 2 anúncios de
 * transferência consecutivos).
 */
export interface AssistedModeRedirectMessages {
  monetary: string;
  booking: string;
  duplicate_handoff: string | null;
}

/**
 * Configuração completa do modo assistido (Blocos 4, 5, 6, 7).
 *
 * - `addendum`: texto concatenado ao L1 (system prompt) por `load-context`
 *   quando `lead.isHumanActive=true && lead.handoffAssumedAt IS NULL`
 *   (Bloco 7 — concept `memory-layers`).
 * - `classifier`: regex compilados no boot que avaliam a saída do LLM
 *   ANTES de enviar (Bloco 5 — concept `response-guard`).
 * - `redirect_messages`: substitutos quando o classifier matcha (Bloco 5).
 */
export interface AssistedModeConfig {
  addendum: string;
  classifier: AssistedModeClassifier;
  redirect_messages: AssistedModeRedirectMessages;
}

/**
 * Tipo unificado dos 5 sub-objetos novos em `agent_configs.hook_params`.
 *
 * **Não inclui** os 5 sub-objetos pré-existentes (`human_delay`,
 * `rate_limit`, `admin_phones`, `booking_link`, `transfer_message`) —
 * cada hook que precisa daqueles continua usando seu `HookParamsShape`
 * local. Este tipo é puramente aditivo.
 *
 * Hooks/utils que vão consumir:
 *   - `format-whatsapp.ts` → `messageSplit`
 *   - `transfer-trigger.ts` → `handoffSupportMessageTemplate`
 *   - `response-guard.ts` → `assistedMode.classifier` + `redirectMessages`
 *   - `load-context.ts` → `assistedMode.addendum`
 *   - `memory/composer.ts` + `memory/l4-rag.ts` → `rag` (Bloco 2-4 da feature
 *     `rag-knowledge-population`, migration 20260510120000)
 *
 * **Convenção:** lê via `(ctx.config?.hookParams ?? {}) as HandoffContinuityHookParams`
 * (mesmo padrão `as HookParamsShape` dos hooks pré-existentes).
 */
export interface HandoffContinuityHookParams {
  message_split?: MessageSplitConfig;
  handoff_support_message_template?: string;
  assisted_mode?: AssistedModeConfig;
  rag?: RagConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG (Bloco 2 — feature `rag-knowledge-population`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sub-objeto `agent_configs.hook_params.rag` (migration 20260510120000).
 *
 * Consumido por:
 *   - `memory/composer.ts` → orquestração do L4
 *   - `memory/l4-rag.ts` → query embed + filtro por threshold + format section
 *   - `scripts/embeddings-backfill.ts` → trunca content por artigo
 *
 * Defaults v4 (canon na migration acima):
 *   { top_k: 3, threshold: 0.7, model: 'text-embedding-3-small',
 *     max_chars_per_article: 600, max_chars_total_section: 2000 }
 *
 * **Threshold é rígido** (concept `rag-knowledge`): artigos com similarity
 * abaixo do valor são DESCARTADOS, não retornados como fallback. Top-K acima
 * de threshold pode retornar 0, 1, 2 ou 3 artigos — "até top-3", não
 * "exatamente top-3".
 */
export interface RagConfig {
  top_k: number;
  threshold: number;
  model: string;
  max_chars_per_article: number;
  max_chars_total_section: number;
}

/**
 * Linha de `knowledge_articles` enriquecida com similaridade calculada
 * pelo pgvector (`1 - (embedding <=> $1)`). Retornada por `loadL4Rag`
 * para o composer (Bloco 4).
 *
 * `similarity` é cosseno (0..1) — quanto mais perto de 1, mais relevante.
 */
export interface KnowledgeArticleMatch {
  id: string;
  title: string;
  content: string;
  category: string;
  similarity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up Pendente (Bloco 2 — feature `follow-up-pendente`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Categorias do follow-up — discriminam qual dos 5 templates é usado pelo
 * renderer (D7'). Detecção via pipeline híbrido (D11'):
 *   1. regex sobre última msg OUTBOUND do agente;
 *   2. fallback por campo NULL do lead (event_type → tipo_evento, etc;
 *      orcamento NÃO detectável por estado — só por regex);
 *   3. fallback genérico usando `{{pergunta_extraida}}` (última frase com `?`
 *      sem o `?`, ou últimas 10 palavras).
 */
export type FollowUpCategoria =
  | 'tipo_evento'
  | 'data'
  | 'convidados'
  | 'orcamento'
  | 'generico';

/**
 * Janela de horário comercial — `start`/`end` em HH:MM 24h, `timezone` IANA.
 * Default v5: { start: '09:00', end: '20:00', timezone: 'America/Sao_Paulo' }.
 */
export interface FollowUpBusinessHours {
  start: string;
  end: string;
  timezone: string;
}

/**
 * 5 templates literais por categoria (D7'). Renderer monta automaticamente
 * `Oi {{nome}}! ` + `<template da categoria>`. Apenas `generico` aceita a
 * variável dinâmica `{{pergunta_extraida}}` (interpolada via
 * `interpolateTemplate`); os outros 4 não têm variáveis interpoladas
 * (são fixos no v1).
 */
export interface FollowUpTemplates {
  tipo_evento: string;
  data: string;
  convidados: string;
  orcamento: string;
  generico: string;
}

/**
 * Sub-objeto `agent_configs.hook_params.follow_up` (migration
 * 20260517100000_follow_up_pipeline).
 *
 * Consumido por:
 *   - `jobs/follow-up-checker.ts` → todos os knobs.
 *   - `templates/follow-up-message.ts` → `templates`.
 *   - `tools/transfer-to-human-standalone.ts` → `escalation_support_template`.
 *   - `rules/follow-up-rules.ts` → `business_hours`, `threshold_minutes`,
 *     `max_attempts_per_24h`, `cooldown_minutes`.
 *
 * Todos os campos são editáveis sem deploy via `jsonb_set` em
 * `agent_configs.hook_params` (concept `hot-reload-config` — cache TTL 30s).
 *
 * **Kill switch:** `enabled: false` faz o cron pular todos os ticks (emit
 * `follow_up_cron_tick_disabled`).
 */
export interface FollowUpConfig {
  enabled: boolean;
  threshold_minutes: number;
  max_attempts_per_24h: number;
  cooldown_minutes: number;
  business_hours: FollowUpBusinessHours;
  rate_limit_sleep_ms: number;
  cron_interval_ms: number;
  templates: FollowUpTemplates;
  escalation_support_template: string;
}

/** Extensão de `HandoffContinuityHookParams` com a chave nova `follow_up`. */
export interface FollowUpHookParams {
  follow_up?: FollowUpConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debounce (Feature A — item 1.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sub-objeto `agent_configs.hook_params.debounce`.
 *
 * Consumido por `queue/producer.ts` no enqueue do webhook — lido DIRETO via
 * `findActiveByKey('angelina')` porque ali ainda não existe HarnessContext.
 *
 * `bucket_ms` = janela de consolidação do debounce (default seguro 2500 quando
 * ausente/inválido). O TTL da LIST Redis é derivado: `max(4× bucket, 10s)`
 * (ver `deriveBucketTtlMs` em `queue/debouncer.ts`).
 */
export interface DebounceConfig {
  bucket_ms: number;
}
