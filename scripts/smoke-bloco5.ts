// scripts/smoke-bloco5.ts
//
// Bloco 5 — Smoke programático do HarnessLoop.
//
// Cenários:
//   A. Fluxo completo (`completed`):
//        - sender.id=5500000005, message.id=smoke-b5-msg-001
//        - cria contact, INSERT inbound, INSERT outbound mock-sent, ~10+ traces
//   B. Duplicate skipped (`completed` + `duplicate_skipped`):
//        - sender.id=5500000006, message.id=smoke-b5-msg-002 (2x)
//        - 1ª = completed (1 inbound, 1 outbound, ~10+ traces)
//        - 2ª = duplicate_skipped (sem novo inbound, 2 traces extras)
//        - SELECT messages com zapster_message_id='smoke-b5-msg-002' = 1 linha
//   C. Agent inactive (`agent_inactive`):
//        - sender.id=5500000007, message.id=smoke-b5-msg-003
//        - is_active=false (já está pré-Bloco 13) → INSERT inbound, SEM outbound
//        - trace `agent_inactive` presente
//
// Cleanup obrigatório (mesmo padrão do Bloco 4):
//   DELETE traces WHERE message_id IN (smoke inbounds);
//   DELETE messages WHERE zapster_message_id LIKE 'smoke-b5-%';
//   DELETE messages WHERE direction='OUTBOUND' AND contact_id IN smoke contacts;
//   DELETE contact_phones WHERE phone IN ('5500000005','5500000006','5500000007');
//   DELETE contacts WHERE id NOT IN (SELECT contact_id FROM contact_phones)
//                    AND name LIKE 'WhatsApp 5500000%';
//
// Uso: `npx tsx scripts/smoke-bloco5.ts` (precisa de DATABASE_URL real;
//      demais env vars podem ser placeholders).

import 'dotenv/config';
import { sql, inArray, eq } from 'drizzle-orm';

import { db, closeDb } from '../src/db/client';
import { contactPhones, contacts, messages, traces } from '../src/db/schema';
import { run as harnessRun } from '../src/harness/loop';
import type { WebhookPayload } from '../src/edge/payload';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildPayload(
  senderPhone: string,
  zapsterMessageId: string,
  text = 'olá',
): WebhookPayload {
  return {
    data: {
      sender: { id: senderPhone },
      recipient: { id: '5519999000000', type: 'chat' },
      message: { id: zapsterMessageId, type: 'text', text },
    },
    raw: { synthetic: true },
  };
}

function buildHeaders(): Record<string, string | undefined> {
  return {
    'x-message-id': 'smoke-b5-headers',
    'x-instance-id': 'smoke-instance',
    'x-webhook-id': 'smoke-webhook',
    'x-attempt-count': '1',
    'user-agent': 'Zapsterapi/smoke',
  };
}

async function snapshot(label: string): Promise<void> {
  const r = await db.execute<{
    messages_test: number;
    traces_test: number;
    whatsapp_contacts: number;
    test_phones: number;
    total_messages: number;
    total_traces: number;
  }>(sql`
    SELECT
      (SELECT count(*) FROM messages
        WHERE contact_id IN (SELECT contact_id FROM contact_phones WHERE phone LIKE '5500000%'))::int AS messages_test,
      (SELECT count(*) FROM traces
        WHERE contact_id IN (SELECT contact_id FROM contact_phones WHERE phone LIKE '5500000%'))::int AS traces_test,
      (SELECT count(*) FROM contacts WHERE origin='WhatsApp')::int AS whatsapp_contacts,
      (SELECT count(*) FROM contact_phones WHERE phone LIKE '5500000%')::int AS test_phones,
      (SELECT count(*) FROM messages)::int AS total_messages,
      (SELECT count(*) FROM traces)::int AS total_traces
  `);
  const row = Array.from(r)[0];
  console.log(`\n[${label}]`, JSON.stringify(row));
}

const SMOKE_PHONES = ['5500000005', '5500000006', '5500000007'];
const SMOKE_ZAPSTER_PREFIX = 'smoke-b5-';

async function cleanup(): Promise<void> {
  console.log('\n[CLEANUP] starting');
  // 1) IDs de inbound/outbound criados pelo smoke (por phone do contato).
  const smokeContactRows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(contactPhones, eq(contactPhones.contactId, contacts.id))
    .where(inArray(contactPhones.phone, SMOKE_PHONES));
  const contactIds = smokeContactRows.map((r) => r.id);
  console.log('[CLEANUP] smoke contact ids', contactIds);

  if (contactIds.length > 0) {
    // 2) Apaga traces ligados a messages desses contatos (FK SET NULL, mas
    //    melhor apagar para não deixar lixo).
    const delTraces = await db
      .delete(traces)
      .where(inArray(traces.contactId, contactIds))
      .returning({ id: traces.id });
    console.log('[CLEANUP] traces deleted', delTraces.length);

    // 3) Apaga messages (inbound smoke + outbound mock).
    const delMsgs = await db
      .delete(messages)
      .where(inArray(messages.contactId, contactIds))
      .returning({ id: messages.id });
    console.log('[CLEANUP] messages deleted', delMsgs.length);

    // 4) Apaga contact_phones.
    const delPhones = await db
      .delete(contactPhones)
      .where(inArray(contactPhones.contactId, contactIds))
      .returning({ id: contactPhones.id });
    console.log('[CLEANUP] contact_phones deleted', delPhones.length);

    // 5) Apaga contacts (só os criados pelo smoke — name LIKE 'WhatsApp 5500000%').
    const delContacts = await db
      .delete(contacts)
      .where(inArray(contacts.id, contactIds))
      .returning({ id: contacts.id });
    console.log('[CLEANUP] contacts deleted', delContacts.length);
  }

  // 6) Defesa-em-profundidade: também caça traces/messages órfãos por
  //    zapster_message_id (caso algum cleanup parcial tenha falhado).
  const orphanMsgs = await db
    .delete(messages)
    .where(sql`zapster_message_id LIKE ${SMOKE_ZAPSTER_PREFIX + '%'}`)
    .returning({ id: messages.id });
  if (orphanMsgs.length > 0) {
    console.log('[CLEANUP] orphan messages by zapster_id deleted', orphanMsgs.length);
  }
  const orphanMockOutbound = await db
    .delete(messages)
    .where(sql`zapster_message_id LIKE 'mock-%' AND direction='OUTBOUND'
               AND created_at > now() - interval '15 minutes'`)
    .returning({ id: messages.id });
  if (orphanMockOutbound.length > 0) {
    console.log('[CLEANUP] orphan mock outbounds deleted', orphanMockOutbound.length);
  }

  console.log('[CLEANUP] done');
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenários
// ─────────────────────────────────────────────────────────────────────────────

interface CaseResult {
  name: string;
  status: string;
  pass: boolean;
  details: Record<string, unknown>;
}

async function smokeA(): Promise<CaseResult> {
  const phone = '5500000005';
  const zapMsgId = 'smoke-b5-msg-001';
  console.log(`\n=== Smoke A — Fluxo completo (${phone}, ${zapMsgId}) ===`);

  // Pré-condição: garantir is_active=true para Smoke A e B (vamos toggle).
  // Decisão: NÃO toggle global aqui. Em vez disso, ATIVAMOS Angelina v2
  // só pela duração do smoke (A e B), e desativamos no finally.
  // Usamos SQL direto para preservar a unicidade do índice parcial
  // `agent_configs_one_active_per_key_uidx` (UPDATE atômico).
  // Para Smoke C (agent_inactive), desativamos antes daquele cenário.

  const result = await harnessRun(buildPayload(phone, zapMsgId, 'olá Angelina'), buildHeaders());
  console.log('  result:', result);

  // Validações
  const inboundQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE zapster_message_id = ${zapMsgId} AND direction='INBOUND'
  `);
  const inboundCount = Array.from(inboundQ)[0].count;

  const outboundQ = await db.execute<{ count: number; mock_zid: string | null }>(sql`
    SELECT count(*)::int AS count, max(zapster_message_id) AS mock_zid
      FROM messages
     WHERE id = ${result.outboundMessageId ?? '00000000-0000-0000-0000-000000000000'}
       AND direction='OUTBOUND' AND send_status='sent'
  `);
  const outboundRow = Array.from(outboundQ)[0];

  const tracesQ = await db.execute<{ count: number; types: string[] }>(sql`
    SELECT count(*)::int AS count, array_agg(distinct event_type) AS types
      FROM traces
     WHERE message_id = ${result.inboundMessageId ?? '00000000-0000-0000-0000-000000000000'}
  `);
  const tracesRow = Array.from(tracesQ)[0];

  const pass =
    result.status === 'completed' &&
    inboundCount === 1 &&
    outboundRow.count === 1 &&
    outboundRow.mock_zid?.startsWith('mock-') === true &&
    tracesRow.count >= 8;

  return {
    name: 'A — completed',
    status: result.status,
    pass,
    details: {
      inboundCount,
      outboundCount: outboundRow.count,
      outboundMockZid: outboundRow.mock_zid,
      tracesCount: tracesRow.count,
      tracesTypes: tracesRow.types,
    },
  };
}

async function smokeB(): Promise<CaseResult> {
  const phone = '5500000006';
  const zapMsgId = 'smoke-b5-msg-002';
  console.log(`\n=== Smoke B — Duplicate skipped (${phone}, ${zapMsgId} 2x) ===`);

  const r1 = await harnessRun(buildPayload(phone, zapMsgId, 'primeira'), buildHeaders());
  console.log('  1st result:', r1);
  const r2 = await harnessRun(buildPayload(phone, zapMsgId, 'segunda (duplicada)'), buildHeaders());
  console.log('  2nd result:', r2);

  // SELECT messages → exatamente 1 linha
  const dupQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE zapster_message_id = ${zapMsgId} AND direction='INBOUND'
  `);
  const inboundCount = Array.from(dupQ)[0].count;

  // SELECT trace `duplicate_skipped` → 1 linha
  const dupTraceQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM traces
     WHERE message_id = ${r1.inboundMessageId ?? '00000000-0000-0000-0000-000000000000'}
       AND event_type = 'duplicate_skipped'
  `);
  const dupTraceCount = Array.from(dupTraceQ)[0].count;

  const pass =
    r1.status === 'completed' &&
    r2.status === 'duplicate_skipped' &&
    inboundCount === 1 &&
    dupTraceCount === 1 &&
    r1.inboundMessageId === r2.inboundMessageId; // mesmo turn_id (= messageId)

  return {
    name: 'B — duplicate_skipped',
    status: `${r1.status} + ${r2.status}`,
    pass,
    details: {
      inboundCount,
      dupTraceCount,
      sameTurnId: r1.inboundMessageId === r2.inboundMessageId,
      r1: r1.status,
      r2: r2.status,
    },
  };
}

async function smokeC(): Promise<CaseResult> {
  const phone = '5500000007';
  const zapMsgId = 'smoke-b5-msg-003';
  console.log(`\n=== Smoke C — Agent inactive (${phone}, ${zapMsgId}) ===`);

  // Pré-condição: GARANTIR que Angelina está com is_active=false.
  await db.execute(sql`
    UPDATE agent_configs SET is_active=false WHERE key='angelina'
  `);

  const result = await harnessRun(buildPayload(phone, zapMsgId, 'agente off'), buildHeaders());
  console.log('  result:', result);

  // INSERT inbound feito, mas sem outbound
  const inboundQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE zapster_message_id = ${zapMsgId} AND direction='INBOUND'
  `);
  const inboundCount = Array.from(inboundQ)[0].count;

  const outboundQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE direction='OUTBOUND'
       AND contact_id IN (SELECT contact_id FROM contact_phones WHERE phone=${phone})
  `);
  const outboundCount = Array.from(outboundQ)[0].count;

  // Trace `agent_inactive` presente
  const inactiveTraceQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM traces
     WHERE message_id = ${result.inboundMessageId ?? '00000000-0000-0000-0000-000000000000'}
       AND event_type = 'agent_inactive'
  `);
  const inactiveTraceCount = Array.from(inactiveTraceQ)[0].count;

  const pass =
    result.status === 'agent_inactive' &&
    inboundCount === 1 &&
    outboundCount === 0 &&
    inactiveTraceCount === 1;

  return {
    name: 'C — agent_inactive',
    status: result.status,
    pass,
    details: { inboundCount, outboundCount, inactiveTraceCount },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Smoke Bloco 5 — HarnessLoop esqueleto (mocks)\n');

  await snapshot('SNAPSHOT BEFORE');

  // Salvar estado atual de is_active (volta no finally se preciso).
  const initialActiveQ = await db.execute<{
    version: number;
    is_active: boolean;
  }>(sql`
    SELECT version, is_active FROM agent_configs
     WHERE key='angelina' ORDER BY version
  `);
  const initialActive = Array.from(initialActiveQ);
  console.log('[STATE] agent_configs.angelina inicial:', initialActive);

  const results: CaseResult[] = [];
  let exitCode = 0;
  try {
    // Para Smoke A e B precisamos is_active=true (Angelina v2).
    // Ativamos via UPDATE atômico (índice parcial garante 1 ativa por key).
    await db.execute(sql`
      UPDATE agent_configs SET is_active = (version = 2)
       WHERE key='angelina'
    `);
    console.log('[STATE] Angelina v2 toggled is_active=true (smoke window)');

    results.push(await smokeA());
    results.push(await smokeB());
    results.push(await smokeC()); // ele mesmo desativa antes

    await snapshot('SNAPSHOT MID (post-smokes, pre-cleanup)');

    console.log('\n=== Resultados ===');
    for (const r of results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'} :: ${r.name} (status=${r.status})`);
      console.log('  details:', JSON.stringify(r.details));
      if (!r.pass) exitCode = 1;
    }
  } catch (err) {
    console.error('FATAL:', err);
    exitCode = 2;
  } finally {
    // Restaurar estado inicial de is_active SEMPRE (precisa antes do cleanup
    // por causa do índice parcial — só pode ter 1 ativa, e cleanup não toca
    // agent_configs).
    try {
      // Desativar todas, depois reativar a que estava ativa (se alguma).
      await db.execute(sql`UPDATE agent_configs SET is_active=false WHERE key='angelina'`);
      const wasActive = initialActive.find((r) => r.is_active);
      if (wasActive) {
        await db.execute(sql`
          UPDATE agent_configs SET is_active=true
           WHERE key='angelina' AND version=${wasActive.version}
        `);
      }
      console.log('[STATE] agent_configs.angelina restored to initial state');
    } catch (err) {
      console.error('[STATE] FAILED to restore agent_configs:', err);
    }

    await cleanup();
    await snapshot('SNAPSHOT AFTER (post-cleanup)');
    await closeDb();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Unhandled error in main:', err);
  process.exit(2);
});
