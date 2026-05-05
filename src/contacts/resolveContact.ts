// src/contacts/resolveContact.ts
//
// Bloco 4 — Task 22.
//
// Resolve um número de telefone (formato Zapster) num `contact_id` do CRM.
// Se o telefone não existir em `contact_phones`, AUTO-CRIA o contact (sem
// lead — decisão Q9 do brief: "Phone desconhecido → auto-criar contact, sem
// lead. Lead nasce no primeiro turno em que a Angelina chama save_lead_info").
//
// Convenção de telefone (decisão registrada no log do Bloco 4 em 2026-05-02):
//   - Formato canônico no banco: E.164 SEM o `+` (ex: `5519997124472`).
//   - Espelha exatamente o que o Zapster envia em `data.sender.id`.
//   - Prefixo de teste: `5500000XXX` (zero contaminação com dados reais).
//   - `normalizeE164` aceita variantes mascaradas/com `+` e padroniza.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { contactPhones, contacts } from '../db/schema';

/**
 * Padroniza um número de telefone para o formato canônico do banco:
 * E.164 SEM o `+`, apenas dígitos (10 a 15 chars).
 *
 * Aceita:
 *   - `(11) 99999-9999`     → assume Brasil (+55) NÃO; mantém como veio (10 dígitos)
 *                             [obs: o Zapster sempre envia já com país, então
 *                              entradas locais 10/11 dígitos vão para teste manual
 *                              e ficam preservadas — quem normaliza para BR é o caller]
 *   - `5511999999999`       → `5511999999999`
 *   - `+5511999999999`      → `5511999999999`
 *   - `+55 (11) 99999-9999` → `5511999999999`
 *
 * @throws Error se a string vazia, não numérica, ou fora do range 10-15 dígitos.
 */
export function normalizeE164(input: string): string {
  if (typeof input !== 'string') {
    throw new Error(`normalizeE164: expected string, got ${typeof input}`);
  }
  // Strip espaços, parênteses, hífens, pontos, e o `+` opcional do começo.
  const digitsOnly = input.replace(/[\s()\-.+]/g, '');
  if (!/^\d{10,15}$/.test(digitsOnly)) {
    throw new Error(
      `normalizeE164: invalid phone format "${input}" → "${digitsOnly}". ` +
        'Expected 10-15 digits in E.164 (without +).',
    );
  }
  return digitsOnly;
}

export interface ResolveContactResult {
  contactId: string;
  isNew: boolean;
  /** `contacts.name` — pode ser placeholder `WhatsApp <phone>` quando o
   *  contato foi auto-criado e ainda não foi renomeado. O composer usa
   *  esse valor para decidir se pede o nome ao cliente. */
  name: string;
}

/**
 * Resolve um telefone para `{contactId, isNew}`. Auto-cria contact se inédito.
 *
 * Algoritmo:
 *   1. Normaliza o phone.
 *   2. SELECT em contact_phones WHERE phone=$1 AND is_whatsapp=true LIMIT 1.
 *      Se encontrar → retorna `{contactId, isNew:false}`.
 *   3. Senão, transação atômica:
 *      a. INSERT em contacts (origin='WhatsApp', ai_state='AUTO',
 *         name='WhatsApp <phone>' como placeholder até operador renomear via CRM).
 *      b. INSERT em contact_phones (contact_id, phone, type='mobile',
 *         is_primary=true, is_whatsapp=true).
 *      c. Retorna `{contactId: <novo>, isNew:true}`.
 *
 * Concorrência: race entre 2 turnos do mesmo contato sem lead pré-existente
 * pode tentar criar 2 contacts. Não há UNIQUE em contact_phones.phone (pode
 * existir o mesmo número em contatos diferentes — política do CRM web), então
 * a transação não previne race. Aceitável para MVP — debounce de 2.5s por
 * contato (Bloco 3) deduplica burst real. Caso vire problema em prod, adicionar
 * UNIQUE PARCIAL em (phone) WHERE is_whatsapp=true.
 */
export async function resolveContactFromPhone(
  phone: string,
): Promise<ResolveContactResult> {
  const normalized = normalizeE164(phone);

  // 1. Busca direta — caminho quente (≥2º turno do mesmo contato).
  const existing = await db
    .select({
      contactId: contactPhones.contactId,
      name: contacts.name,
    })
    .from(contactPhones)
    .innerJoin(contacts, eq(contacts.id, contactPhones.contactId))
    .where(
      and(
        eq(contactPhones.phone, normalized),
        eq(contactPhones.isWhatsapp, true),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return {
      contactId: existing[0].contactId,
      isNew: false,
      name: existing[0].name,
    };
  }

  // 2. Auto-create transacional.
  const placeholderName = `WhatsApp ${normalized}`;
  const result = await db.transaction(async (tx) => {
    const [newContact] = await tx
      .insert(contacts)
      .values({
        name: placeholderName,
        origin: 'WhatsApp',
        aiState: 'AUTO',
      })
      .returning({ id: contacts.id });

    await tx.insert(contactPhones).values({
      contactId: newContact.id,
      phone: normalized,
      type: 'mobile',
      isPrimary: true,
      isWhatsapp: true,
    });

    return newContact.id;
  });

  return { contactId: result, isNew: true, name: placeholderName };
}

/** Detecta se um nome de contato é o placeholder de auto-criação
 *  (`WhatsApp <dígitos>`). O composer usa esse predicado para decidir se
 *  pede o nome ao cliente. */
export function isPlaceholderContactName(name: string): boolean {
  return /^WhatsApp \d+$/.test(name.trim());
}
