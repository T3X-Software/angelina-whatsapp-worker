// src/contacts/resolveActiveLead.ts
//
// Bloco 4 — Task 23. Atualizado em 2026-05-04 para suportar múltiplos leads
// ativos por contato (revisão da decisão original "1 lead ativo por contato").
//
// Hoje retornamos uma lista de candidatos. O loop decide:
//   - 1 candidato → usa esse lead (caminho original).
//   - 0 candidatos → contato sem lead (caminho original).
//   - 2+ candidatos → atendimento ambíguo. O loop deixa `ctx.lead = null` e
//     popula `ctx.leadCandidates` para o composer pedir desambiguação ao
//     cliente antes de qualquer outra ação.
//
// Decisão Q9 do brief (mantida): NÃO criar lead automaticamente aqui. Lead
// nasce só quando a Angelina chama `save_lead_info`.
//
// Wrapper de retro-compatibilidade `resolveActiveLead(contactId)` é mantido
// para o consumer pre-claim (que precisa de 1 leadId ou null para o
// `claimMessage`). Quando ambíguo, retorna `null` — o `messages.lead_id` fica
// NULL e a mensagem é vinculada ao contato via `contact_id` (suficiente para
// o L1 da memória, que filtra por contact_id).

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { leads } from '../db/schema';

export interface ActiveLeadSnapshot {
  id: string;
  classification: string | null;
  eventType: string | null;
  eventDate: string | null;
  guestCount: number | null;
  estimatedBudget: string | null;
  preferences: string | null;
  notes: string | null;
  visitScheduledAt: string | null;
  isHumanActive: boolean;
  lastActivityAt: string | null;
}

/**
 * Retorna TODOS os leads OPEN (não-deletados) do contato em ordem
 * `last_activity_at DESC NULLS LAST, created_at DESC`. Vazio quando nenhum.
 */
export async function resolveActiveLeads(
  contactId: string,
): Promise<ActiveLeadSnapshot[]> {
  const rows = await db.execute<{
    id: string;
    classification: string | null;
    event_type: string | null;
    event_date: string | null;
    guest_count: number | null;
    estimated_budget: string | null;
    preferences: string | null;
    notes: string | null;
    visit_scheduled_at: string | null;
    is_human_active: boolean;
    last_activity_at: string | null;
  }>(sql`
    SELECT id::text                       AS id,
           classification::text            AS classification,
           event_type::text                AS event_type,
           event_date::text                AS event_date,
           guest_count                     AS guest_count,
           estimated_budget::text          AS estimated_budget,
           preferences                     AS preferences,
           notes                           AS notes,
           visit_scheduled_at::text        AS visit_scheduled_at,
           COALESCE(is_human_active,false) AS is_human_active,
           last_activity_at::text          AS last_activity_at
      FROM leads
     WHERE contact_id = ${contactId}
       AND deleted_at IS NULL
       AND status     = 'OPEN'
     ORDER BY last_activity_at DESC NULLS LAST, created_at DESC
  `);
  const arr = Array.from(rows);
  return arr.map((r) => ({
    id: r.id,
    classification: r.classification,
    eventType: r.event_type,
    eventDate: r.event_date,
    guestCount: r.guest_count,
    estimatedBudget: r.estimated_budget,
    preferences: r.preferences,
    notes: r.notes,
    visitScheduledAt: r.visit_scheduled_at,
    isHumanActive: r.is_human_active,
    lastActivityAt: r.last_activity_at,
  }));
}

/**
 * Retorna o leadId quando há EXATAMENTE 1 lead ativo, ou `null` quando há 0
 * ou 2+ (ambíguo). Wrapper retro-compatível para callers que só precisam de
 * um único id (ex.: pre-claim do consumer).
 *
 * Implementação enxuta — não chama `resolveActiveLeads` para não puxar 9
 * colunas do banco quando só precisamos de id+count.
 */
export async function resolveActiveLead(
  contactId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.contactId, contactId),
        isNull(leads.deletedAt),
        eq(leads.status, 'OPEN'),
      ),
    )
    .orderBy(sql`${leads.lastActivityAt} DESC NULLS LAST`, desc(leads.createdAt))
    .limit(2); // 2 é suficiente para detectar ambíguo

  if (rows.length === 1) return rows[0].id;
  return null;
}
