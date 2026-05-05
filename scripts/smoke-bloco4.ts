// scripts/smoke-bloco4.ts
//
// Smoke programático do Bloco 4 (Resolução phone → contact / lead).
// Roda contra o banco em prod (`nzthpnmrposhndmespnh`) com phone fictício
// `5500000001` (prefixo de teste — zero contaminação com dados reais).
//
// Como rodar (a partir de whatsapp-worker/, com .env preenchido):
//   npx tsx scripts/smoke-bloco4.ts
//
// Cleanup: cada execução deleta o contact+phone criados ao final, mesmo em
// caso de erro nas asserções (try/finally).

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client';
import { contacts, contactPhones } from '../src/db/schema';
import {
  normalizeE164,
  resolveContactFromPhone,
} from '../src/contacts/resolveContact';
import { resolveActiveLead } from '../src/contacts/resolveActiveLead';

// Canônico: 10 dígitos seguindo a convenção do Bloco 4 (prefixo de teste
// 5500000XXX). 10 dígitos é deliberadamente curto para garantir zero colisão
// com qualquer DDI/DDD real (E.164 brasileiro tem ≥12 com país 55).
//
// Variantes têm que conter EXATAMENTE os mesmos 10 dígitos quando despidas
// de máscara — qualquer diferença é bug de premissa, não de código.
//   `+5500000001`   → 10 dígitos (apenas adiciona `+`).
//   `5500-000-001`  → 10 dígitos (adiciona hífens).
//   `(55) 00000001` → 10 dígitos (adiciona parens + espaço).
const TEST_PHONE_RAW = '5500000001';
const TEST_PHONE_VARIANT_1 = '+5500000001';
const TEST_PHONE_VARIANT_2 = '5500-000-001';
const TEST_PHONE_VARIANT_3 = '(55) 00000001';

function log(step: string, msg: string, extra?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(`[smoke-bloco4] [${step}] ${msg}`, extra ?? '');
}

async function snapshot() {
  const rows = await db.execute<{
    whatsapp_contacts: number;
    test_phones: number;
    total_phones: number;
    total_contacts: number;
  }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    `SELECT
       (SELECT count(*)::int FROM contacts WHERE origin='WhatsApp')      AS whatsapp_contacts,
       (SELECT count(*)::int FROM contact_phones WHERE phone LIKE '5500000%') AS test_phones,
       (SELECT count(*)::int FROM contact_phones)                         AS total_phones,
       (SELECT count(*)::int FROM contacts)                               AS total_contacts` as never,
  );
  return rows[0];
}

async function main() {
  let exitCode = 0;
  let createdContactId: string | null = null;

  try {
    log('snapshot:before', 'capturando contadores antes do smoke');
    const before = await snapshot();
    log('snapshot:before', 'snapshot inicial', before);

    // ── Caso 1: normalizeE164 padroniza variantes ─────────────────────────
    const a = normalizeE164(TEST_PHONE_RAW);
    const b = normalizeE164(TEST_PHONE_VARIANT_1);
    const c = normalizeE164(TEST_PHONE_VARIANT_2);
    const d = normalizeE164(TEST_PHONE_VARIANT_3);
    if (a !== TEST_PHONE_RAW)
      throw new Error(`normalize(canonical) esperava "${TEST_PHONE_RAW}", veio "${a}"`);
    if (b !== TEST_PHONE_RAW)
      throw new Error(`normalize(variante1) esperava "${TEST_PHONE_RAW}", veio "${b}"`);
    if (c !== TEST_PHONE_RAW)
      throw new Error(`normalize(variante2) esperava "${TEST_PHONE_RAW}", veio "${c}"`);
    if (d !== TEST_PHONE_RAW)
      throw new Error(`normalize(variante3) esperava "${TEST_PHONE_RAW}", veio "${d}"`);
    log('case1', 'normalizeE164 OK em todas as variantes', {
      canonical: a,
      variant1: b,
      variant2: c,
      variant3: d,
    });

    // ── Caso 1b: normalizeE164 rejeita inputs inválidos ──────────────────
    const invalidInputs = ['', 'abc', '123', '12345678901234567']; // <10 ou >15
    for (const bad of invalidInputs) {
      let threw = false;
      try {
        normalizeE164(bad);
      } catch {
        threw = true;
      }
      if (!threw)
        throw new Error(`normalize("${bad}") deveria ter lançado, mas não lançou`);
    }
    log('case1b', 'normalizeE164 rejeita inputs inválidos OK', {
      tested: invalidInputs,
    });

    // ── Caso 2: 1ª resolução (auto-create) ────────────────────────────────
    const r1 = await resolveContactFromPhone(TEST_PHONE_RAW);
    log('case2', 'resolveContactFromPhone (1ª chamada)', r1);
    if (!r1.isNew) throw new Error(`1ª chamada deveria ter isNew=true, veio ${r1.isNew}`);
    if (!r1.contactId) throw new Error('1ª chamada deveria ter contactId definido');
    createdContactId = r1.contactId;

    // ── Caso 3: 2ª resolução com formato VARIADO → mesmo contactId ────────
    const r2 = await resolveContactFromPhone(TEST_PHONE_VARIANT_3);
    log('case3', 'resolveContactFromPhone (2ª chamada com variante)', r2);
    if (r2.isNew !== false)
      throw new Error(`2ª chamada deveria ter isNew=false, veio ${r2.isNew}`);
    if (r2.contactId !== r1.contactId)
      throw new Error(
        `2ª chamada deveria retornar mesmo contactId. ` +
          `1ª="${r1.contactId}", 2ª="${r2.contactId}". ` +
          `Prova de que normalização funcionou.`,
      );
    log('case3', 'normalização confirmada — mesmo contactId apesar do formato variado');

    // ── Caso 4: resolveActiveLead → null (Q9: auto-criou contact, sem lead)
    const leadId = await resolveActiveLead(r1.contactId);
    log('case4', 'resolveActiveLead', { leadId });
    if (leadId !== null)
      throw new Error(`resolveActiveLead deveria ser null (Q9 brief), veio "${leadId}"`);

    // ── Snapshot intermediário (ainda sem cleanup) ────────────────────────
    const mid = await snapshot();
    log('snapshot:mid', 'após auto-create, antes do cleanup', mid);
    if (mid.whatsapp_contacts !== before.whatsapp_contacts + 1)
      throw new Error(
        `whatsapp_contacts esperava +1: before=${before.whatsapp_contacts}, mid=${mid.whatsapp_contacts}`,
      );
    if (mid.test_phones !== before.test_phones + 1)
      throw new Error(
        `test_phones esperava +1: before=${before.test_phones}, mid=${mid.test_phones}`,
      );

    log('done', 'todos os casos passaram ✓');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[smoke-bloco4] FALHA:', err);
    exitCode = 1;
  } finally {
    // ── Cleanup obrigatório ──────────────────────────────────────────────
    if (createdContactId) {
      try {
        await db.delete(contactPhones).where(eq(contactPhones.contactId, createdContactId));
        await db.delete(contacts).where(eq(contacts.id, createdContactId));
        log('cleanup', `contact + phones removidos (contactId=${createdContactId})`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[smoke-bloco4] erro no cleanup:', err);
        exitCode = exitCode || 2;
      }
    }
    const after = await snapshot();
    log('snapshot:after', 'após cleanup', after);
    await closeDb();
    process.exit(exitCode);
  }
}

void main();
