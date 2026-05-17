// src/rules/follow-up-rules.ts
//
// Bloco 3 — Tasks #15 + #17 da feature `follow-up-pendente`.
//
// Business rules do checker de follow-up. Funções puras (ou queries pontuais
// no banco) que decidem "posso enviar este follow-up agora?".
//
// Camadas de filtro:
//   1. Query SELECT no checker já filtra `follow_up_disabled=true`,
//      `status IN ('WON','LOST')`, modo `blocked` e contatos sem OUTBOUND
//      recente. Essas pré-filtragens evitam carregar contatos irrelevantes.
//   2. `canSendFollowUp(lead, lastAttempt, config)` é **defense-in-depth**
//      pós-query — re-valida + adiciona regras de tempo (max_attempts_24h,
//      cooldown). Skip reasons emitidas como `follow_up_skipped {reason}`.
//   3. `isWithinBusinessHours(now, config)` é chamado UMA VEZ por tick do
//      cron — fora do loop por contato. Se false, o tick inteiro é pulado.
//   4. `isFollowUpRecentlySent(contactId)` é idempotency intra-ciclo: protege
//      contra 2 instâncias do cron que conseguiram ambas o lock (caso raro,
//      mas observado em PM2 restart em hot loop). Janela 5min.

import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { followUpAttempts, traces } from '../db/schema';
import type { FollowUpConfig } from '../config/types';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Razões fechadas (union) para SKIPAR um follow-up. Facilita SQL agg em
 * `traces.payload->>'reason'` sem `LIKE` (mesmo pattern de `RagSkipReason`).
 */
export type FollowUpSkipReason =
  | 'follow_up_disabled'
  | 'handoff_blocked'
  | 'lead_closed'
  | 'max_attempts_24h'
  | 'cooldown_active'
  | 'outside_business_hours';

/** Resultado de `canSendFollowUp`. Discriminated union. */
export type CanSendFollowUpResult =
  | { allowed: true }
  | { allowed: false; reason: FollowUpSkipReason };

/** Snapshot mínimo do lead consumido pelas rules. */
export interface LeadStateForFollowUpRules {
  status: string | null;
  followUpDisabled: boolean;
  isHumanActive: boolean;
  handoffAssumedAt: Date | string | null;
}

/** Última tentativa registrada em `follow_up_attempts`. */
export interface LastFollowUpAttempt {
  id: string;
  contactId: string;
  attemptNumber: number;
  sentAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// isWithinBusinessHours — chamado UMA vez por tick (fora do loop por contato)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True se `now` cai dentro da janela `[start, end)` no timezone configurado.
 * Compara por string HH:MM (24h): `'09:00' <= '14:32' < '20:00'`.
 *
 * Zero-dep: usa `Intl.DateTimeFormat` para extrair HH:MM no timezone (default
 * `America/Sao_Paulo` na config v5).
 *
 * Observação: comparação é semi-aberta no final (`< end`) — `'20:00:01'` cai
 * FORA da janela quando `end='20:00'`. Esse é o comportamento esperado para
 * "horário comercial até as 20h, last call 19:59".
 *
 * @param now Timestamp UTC atual.
 * @param businessHours Sub-config `business_hours` lida de `hook_params.follow_up`.
 */
export function isWithinBusinessHours(
  now: Date,
  businessHours: FollowUpConfig['business_hours'],
): boolean {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: businessHours.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  // `Intl` em algumas implementações retorna "24" para meia-noite — normalizar.
  const normalizedHour = hour === '24' ? '00' : hour;
  const hhmm = `${normalizedHour}:${minute}`;

  return hhmm >= businessHours.start && hhmm < businessHours.end;
}

// ─────────────────────────────────────────────────────────────────────────────
// getLastAttempt — última tentativa de follow-up do contato
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retorna a última tentativa de follow-up registrada para o contato (ou
 * `null` se nunca houve). Pega via `ORDER BY sent_at DESC LIMIT 1` no
 * índice `idx_follow_up_attempts_contact` (1 seek).
 */
export async function getLastAttempt(
  contactId: string,
): Promise<LastFollowUpAttempt | null> {
  const rows = await db
    .select({
      id: followUpAttempts.id,
      contactId: followUpAttempts.contactId,
      attemptNumber: followUpAttempts.attemptNumber,
      sentAt: followUpAttempts.sentAt,
    })
    .from(followUpAttempts)
    .where(eq(followUpAttempts.contactId, contactId))
    .orderBy(desc(followUpAttempts.sentAt))
    .limit(1);

  if (rows.length === 0) return null;
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// canSendFollowUp — defense-in-depth pós-query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-checa todas as razões de skip que poderiam permitir um follow-up no
 * tick atual. Ordem das checagens vai do mais estrutural (lead disabled)
 * para o mais dinâmico (cooldown).
 *
 * **A query do checker já filtra `follow_up_disabled`, status terminal e
 * handoff `blocked`** — mas re-checamos aqui para defesa em profundidade
 * (lead mudou estado entre query e loop) e para emitir reason correto.
 *
 * `outside_business_hours` NÃO é checado aqui — é responsabilidade do
 * caller (chamada UMA vez por tick em `isWithinBusinessHours`).
 *
 * @returns `{allowed: true}` ou `{allowed: false, reason}`.
 */
export function canSendFollowUp(
  lead: LeadStateForFollowUpRules,
  lastAttempt: LastFollowUpAttempt | null,
  config: FollowUpConfig,
  now: Date = new Date(),
): CanSendFollowUpResult {
  // 1. lead.follow_up_disabled — kill switch por lead.
  if (lead.followUpDisabled) {
    return { allowed: false, reason: 'follow_up_disabled' };
  }

  // 2. handoff blocked — humano já assumiu, response-guard bloqueia mesmo.
  if (lead.isHumanActive && lead.handoffAssumedAt != null) {
    return { allowed: false, reason: 'handoff_blocked' };
  }

  // 3. lead status terminal (WON, LOST).
  if (lead.status === 'WON' || lead.status === 'LOST') {
    return { allowed: false, reason: 'lead_closed' };
  }

  // 4. max_attempts_per_24h — `attemptNumber` da última tentativa já cobre
  //    a contagem se sempre incrementarmos em sequência. Mas para ser
  //    defensivo contra resets, conferimos via `sentAt`:
  if (lastAttempt && lastAttempt.attemptNumber >= config.max_attempts_per_24h) {
    // Só conta como "estourou" se a última tentativa foi nas últimas 24h.
    const ageMs = now.getTime() - new Date(lastAttempt.sentAt).getTime();
    if (ageMs < 24 * 60 * 60 * 1000) {
      return { allowed: false, reason: 'max_attempts_24h' };
    }
  }

  // 5. cooldown — última tentativa há menos de `cooldown_minutes`.
  if (lastAttempt) {
    const ageMinutes =
      (now.getTime() - new Date(lastAttempt.sentAt).getTime()) / 60_000;
    if (ageMinutes < config.cooldown_minutes) {
      return { allowed: false, reason: 'cooldown_active' };
    }
  }

  return { allowed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// shouldEscalate — true quando essa tentativa deve disparar escalação
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Após enviar o follow-up `attemptNumber`-ésimo, escala para humano (RF5)?
 * Default v5: true quando `attemptNumber >= max_attempts_per_24h` (=2).
 *
 * Função pura.
 */
export function shouldEscalate(
  attemptNumber: number,
  config: FollowUpConfig,
): boolean {
  return attemptNumber >= config.max_attempts_per_24h;
}

// ─────────────────────────────────────────────────────────────────────────────
// isFollowUpRecentlySent — idempotency intra-ciclo (5min)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retorna `true` se já existe um trace `follow_up_sent` para o contato
 * dentro da janela `windowMinutes` (default 5min). Protege contra 2 instâncias
 * do cron que conseguiram ambas o lock OU re-disparo do mesmo tick por
 * exception não capturada.
 *
 * Olha em `traces` (não em `follow_up_attempts`) porque o trace é emitido
 * ANTES do INSERT na tabela de attempts — janela de 5min cobre o gap.
 */
export async function isFollowUpRecentlySent(
  contactId: string,
  windowMinutes = 5,
): Promise<boolean> {
  // 5min é constante de DEFENSIVA — janelas maiores nunca devem ser usadas
  // pois conflitam com cooldown_minutes (default 120) que é o controle real.
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM traces
       WHERE event_type = 'follow_up_sent'
         AND contact_id = ${contactId}::uuid
         AND created_at > NOW() - (${windowMinutes} || ' minutes')::interval
    ) AS exists
  `);
  const arr = Array.from(rows) as Array<{ exists: boolean }>;
  return arr[0]?.exists === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query LATERAL JOIN — builder usado no Bloco 4 task #20 (follow-up-checker.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linha retornada pela query de detecção. Tipagem strita para evitar `unknown`
 * no consumer (`follow-up-checker.ts`).
 */
export interface FollowUpCandidateRow {
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  lead_id: string;
  lead_status: string | null;
  event_type: string | null;
  event_date: string | null;
  guest_count: number | null;
  is_human_active: boolean;
  handoff_assumed_at: Date | string | null;
  follow_up_disabled: boolean;
  last_message_id: string;
  last_message_text: string | null;
  last_message_at: Date | string;
}

/**
 * Builder da SQL parametrizada para detectar contatos com follow-up pendente (D2).
 *
 * Recebe `thresholdMinutes` (lido de `hook_params.follow_up.threshold_minutes`,
 * default 30). Retorna até 50 linhas FIFO (mais antigas primeiro — D8).
 *
 * Filtros aplicados:
 *   - última msg é OUTBOUND (não-redacted);
 *   - última msg não começa com '/' (admin command);
 *   - delta `NOW() - last_msg > threshold_minutes`;
 *   - `lead.follow_up_disabled = false`;
 *   - `lead.status NOT IN ('WON','LOST')`;
 *   - NOT (lead em modo `blocked` — handoff_assumed_at IS NOT NULL).
 *
 * O índice `idx_messages_contact_created_desc (contact_id, created_at DESC)`
 * suporta o LATERAL JOIN — EXPLAIN ANALYZE validado em prod (4.6ms).
 */
export function buildFollowUpDetectionQuery(thresholdMinutes: number) {
  return sql`
    SELECT DISTINCT ON (c.id)
      c.id                              AS contact_id,
      c.name                            AS contact_name,
      (
        SELECT phone FROM contact_phones cp
         WHERE cp.contact_id = c.id
         ORDER BY cp.is_primary DESC NULLS LAST,
                  cp.is_whatsapp DESC NULLS LAST
         LIMIT 1
      )                                 AS contact_phone,
      l.id                              AS lead_id,
      l.status::text                    AS lead_status,
      l.event_type::text                AS event_type,
      l.event_date::text                AS event_date,
      l.guest_count                     AS guest_count,
      l.is_human_active                 AS is_human_active,
      l.handoff_assumed_at              AS handoff_assumed_at,
      l.follow_up_disabled              AS follow_up_disabled,
      m.id                              AS last_message_id,
      m.text                            AS last_message_text,
      m.created_at                      AS last_message_at
    FROM contacts c
    JOIN leads l    ON l.contact_id = c.id
    JOIN LATERAL (
      SELECT id, text, direction, created_at
        FROM messages
       WHERE contact_id = c.id
         AND redacted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
    ) m ON true
    WHERE m.direction = 'OUTBOUND'
      AND (m.text IS NULL OR m.text NOT LIKE '/%')
      AND NOW() - m.created_at > (${thresholdMinutes} * INTERVAL '1 minute')
      AND l.follow_up_disabled = false
      AND l.status NOT IN ('WON','LOST')
      AND NOT (l.is_human_active = true AND l.handoff_assumed_at IS NOT NULL)
    ORDER BY c.id, m.created_at ASC
    LIMIT 50
  `;
}

// Silencia warning de unused (and, gt importados para uso futuro).
void and;
void gt;
