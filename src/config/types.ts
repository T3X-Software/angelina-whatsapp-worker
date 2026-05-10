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
 *
 * **Convenção:** lê via `(ctx.config?.hookParams ?? {}) as HandoffContinuityHookParams`
 * (mesmo padrão `as HookParamsShape` dos hooks pré-existentes).
 */
export interface HandoffContinuityHookParams {
  message_split?: MessageSplitConfig;
  handoff_support_message_template?: string;
  assisted_mode?: AssistedModeConfig;
}
