// scripts/smoke-bloco9.ts
//
// Bloco 9 — Smoke programático MÍNIMO (modo econômico, 2 cenários).
//
//   Smoke 1 — happy path send REAL (REQUER ZAPSTER_* reais + phone confirmado).
//     Pré-condições:
//       - .env com ZAPSTER_API_URL/ZAPSTER_API_KEY/ZAPSTER_INSTANCE_ID reais.
//       - Phone de destino REAL confirmado por env var SMOKE_B9_REAL_PHONE
//         (E.164 sem `+`). Sem isso, ABORTA o Smoke 1.
//     Inserimos 1 outbound `pending` direto no banco e chamamos
//     sendWithStateMachine. Esperamos {status:'sent'},
//     messages.zapster_message_id populado, send_status='sent',
//     send_attempts=1, send_attempted_at NOT NULL.
//
//   Smoke 2 — race condition (NÃO requer Zapster real).
//     Mock client que apenas resolve {zapsterMessageId:'mock-race'}.
//     Inserimos 1 outbound `pending`. Chamamos sendWithStateMachine 2× em
//     paralelo. Esperamos: 1 retorna 'sent', outra 'race_lost'. Estado final:
//     send_status='sent', send_attempts=1 (não 2 — race_lost não conta).
//
// Cleanup obrigatório no finally — DELETE traces/messages/contact_phones/contacts
// dos phones smoke (cuida das FKs).
//
// SQL antes/depois (modo econômico): 1 SELECT count agregado de cada lado,
// expect 0 depois.

import 'dotenv/config';
import { sql, inArray } from 'drizzle-orm';
import pino from 'pino';

import { db, closeDb } from '../src/db/client';
import {
  contactPhones,
  contacts,
  messages,
  traces,
} from '../src/db/schema';
import { createEventBus } from '../src/harness/event-bus';
import { ZapsterClient } from '../src/zapster/client';
import { sendWithStateMachine } from '../src/zapster/sender';
import type { ZapsterSendInput, ZapsterSendResult } from '../src/zapster/types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants / helpers
// ─────────────────────────────────────────────────────────────────────────────

const SMOKE_PHONES = [
  '5500000090', // Smoke 1 — happy path (origin contact, NOT recipient)
  '5500000091', // Smoke 2 — race
];

const SMOKE_ZID_PATTERNS = ['smoke-b9-%', 'mock-race'];

const logger = pino({ level: 'warn' });

interface AggSnapshot {
  msgs_b9: number;
  traces_b9: number;
  total_messages: number;
  total_traces: number;
}

async function snapshot(label: string): Promise<AggSnapshot> {
  const r = await db.execute<AggSnapshot>(sql`
    SELECT
      (SELECT count(*) FROM messages
        WHERE zapster_message_id LIKE 'smoke-b9-%' OR zapster_message_id = 'mock-race'
      )::int AS msgs_b9,
      (SELECT count(*) FROM traces
        WHERE message_id IN (
          SELECT id FROM messages
           WHERE zapster_message_id LIKE 'smoke-b9-%' OR zapster_message_id = 'mock-race'
        )
      )::int AS traces_b9,
      (SELECT count(*) FROM messages)::int AS total_messages,
      (SELECT count(*) FROM traces)::int AS total_traces
  `);
  const row = Array.from(r)[0];
  console.log(`\n[${label}]`, JSON.stringify(row));
  return row;
}

async function ensureContact(phone: string): Promise<string> {
  // Insere se não existir; reusa se existir.
  const existing = await db
    .select({ id: contactPhones.contactId })
    .from(contactPhones)
    .where(sql`${contactPhones.phone} = ${phone}`)
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const c = await db
    .insert(contacts)
    .values({ name: `WhatsApp ${phone}`, origin: 'WhatsApp' })
    .returning({ id: contacts.id });
  await db.insert(contactPhones).values({
    contactId: c[0].id,
    phone,
    type: 'mobile',
    isPrimary: true,
    isWhatsapp: true,
  });
  return c[0].id;
}

async function insertPendingOutbound(
  contactId: string,
  text: string,
  recipientId: string,
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      contactId,
      direction: 'OUTBOUND',
      role: 'assistant',
      text,
      recipientId,
      recipientType: 'chat',
      sendStatus: 'pending',
    })
    .returning({ id: messages.id });
  return row.id;
}

async function readMessage(id: string): Promise<{
  send_status: string | null;
  send_attempts: number | null;
  send_attempted_at: string | null;
  zapster_message_id: string | null;
} | null> {
  const r = await db.execute<{
    send_status: string | null;
    send_attempts: number | null;
    send_attempted_at: string | null;
    zapster_message_id: string | null;
  }>(sql`
    SELECT send_status::text AS send_status,
           send_attempts,
           send_attempted_at::text AS send_attempted_at,
           zapster_message_id
      FROM messages WHERE id = ${id}
  `);
  return Array.from(r)[0] ?? null;
}

async function cleanup(): Promise<void> {
  console.log('\n[CLEANUP] starting');
  // Ordem: traces -> messages -> contact_phones -> contacts.
  // Como o smoke insere por contactId, capturamos ids dos phones do smoke.
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(
      contactPhones,
      sql`${contactPhones.contactId} = ${contacts.id}`,
    )
    .where(inArray(contactPhones.phone, SMOKE_PHONES));
  const contactIds = rows.map((r) => r.id);

  if (contactIds.length > 0) {
    // Ordem importa: precisamos deletar TODOS os traces ligados ao smoke
    // (por message_id ou por contact_id) ANTES de deletar contacts —
    // senão o FK `traces.contact_id ON DELETE SET NULL` deixa órfãos.
    const msgRows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.contactId, contactIds));
    const msgIds = msgRows.map((r) => r.id);
    if (msgIds.length > 0) {
      await db.delete(traces).where(inArray(traces.messageId, msgIds));
    }
    // Traces que foram emitidos com contactId mas sem messageId
    // (smoke chama emit antes de bindMessageId — caso do sender direto).
    await db.delete(traces).where(inArray(traces.contactId, contactIds));

    await db.delete(messages).where(inArray(messages.contactId, contactIds));
    await db
      .delete(contactPhones)
      .where(inArray(contactPhones.contactId, contactIds));
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }

  // Belt-and-suspenders: pega qualquer resíduo por padrão de zapster_message_id.
  await db.execute(sql`
    DELETE FROM traces
     WHERE message_id IN (
       SELECT id FROM messages
        WHERE zapster_message_id LIKE 'smoke-b9-%' OR zapster_message_id = 'mock-race'
     )
  `);
  await db.execute(sql`
    DELETE FROM messages
     WHERE zapster_message_id LIKE 'smoke-b9-%' OR zapster_message_id = 'mock-race'
  `);
  console.log('[CLEANUP] done');
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke 1 — happy path REAL Zapster
// ─────────────────────────────────────────────────────────────────────────────

async function smoke1HappyPath(): Promise<{
  pass: boolean;
  details: string;
  skipped?: boolean;
}> {
  console.log('\n=== Smoke 1: Happy path send REAL Zapster ===');

  // Pré-condição A: ZAPSTER_* não pode estar com dummies do Bloco 8.
  const apiKey = process.env.ZAPSTER_API_KEY ?? '';
  const instanceId = process.env.ZAPSTER_INSTANCE_ID ?? '';
  if (
    apiKey.startsWith('dummy-') ||
    instanceId.startsWith('dummy-') ||
    !apiKey ||
    !instanceId
  ) {
    return {
      pass: false,
      skipped: true,
      details: `ABORTED — ZAPSTER_* ainda com dummies (api_key='${apiKey.slice(0, 6)}...', instance_id='${instanceId}'). Atualize whatsapp-worker/.env com creds reais antes de rodar Smoke 1.`,
    };
  }

  // Pré-condição B: phone de destino REAL confirmado por env var.
  const realPhone = process.env.SMOKE_B9_REAL_PHONE ?? '';
  if (!realPhone || !/^\d{10,15}$/.test(realPhone)) {
    return {
      pass: false,
      skipped: true,
      details:
        'ABORTED — SMOKE_B9_REAL_PHONE não confirmado (formato esperado: E.164 sem `+`, ex: 5519997124472). Sem confirmação, NÃO disparamos API call para phone aleatório.',
    };
  }

  const contactId = await ensureContact(SMOKE_PHONES[0]);
  const text = `[Bloco 9 smoke ${new Date().toISOString()}] Mensagem de validação automatizada do Espaço Angelinos. Pode ignorar.`;
  const outboundId = await insertPendingOutbound(contactId, text, realPhone);
  console.log('  outboundId:', outboundId, 'phone destino:', realPhone);

  const client = new ZapsterClient(logger);
  const bus = createEventBus(outboundId, contactId, null);

  const result = await sendWithStateMachine(
    outboundId,
    client,
    {
      recipientId: realPhone,
      recipientType: 'chat',
      text,
    },
    bus,
  );
  console.log('  sender result:', JSON.stringify(result));
  await bus.flushToDatabase();

  if (result.status !== 'sent') {
    return {
      pass: false,
      details: `expected status=sent, got ${result.status} (error=${result.error ?? '-'}, statusCode=${result.statusCode ?? 0})`,
    };
  }
  if (!result.zapsterMessageId) {
    return { pass: false, details: 'missing zapsterMessageId in result' };
  }

  const row = await readMessage(outboundId);
  if (!row) return { pass: false, details: 'outbound row not found post-send' };
  console.log('  outbound row:', JSON.stringify(row));

  if (row.send_status !== 'sent') {
    return {
      pass: false,
      details: `expected send_status=sent in DB, got ${row.send_status}`,
    };
  }
  if (row.zapster_message_id !== result.zapsterMessageId) {
    return {
      pass: false,
      details: `zapster_message_id mismatch: db=${row.zapster_message_id}, result=${result.zapsterMessageId}`,
    };
  }
  if (!row.send_attempted_at) {
    return { pass: false, details: 'send_attempted_at NULL — CHECK_3 violado' };
  }
  if ((row.send_attempts ?? 0) !== 1) {
    return {
      pass: false,
      details: `expected send_attempts=1, got ${row.send_attempts}`,
    };
  }

  // Renomeia zapster_message_id para o padrão smoke-b9-* para o cleanup
  // pegar via LIKE. Mantemos cópia em campo zapster_attempt_count para auditoria
  // não — só renomeamos prefix e logamos. (Simples.)
  await db.execute(sql`
    UPDATE messages
       SET zapster_message_id = ${'smoke-b9-real-' + result.zapsterMessageId}
     WHERE id = ${outboundId}
  `);
  console.log(
    '  renamed zapster_message_id to smoke-b9-real-* for cleanup match',
  );

  return {
    pass: true,
    details: `ok — zapster_message_id=${result.zapsterMessageId}, send_attempts=1`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke 2 — race condition (mock client)
// ─────────────────────────────────────────────────────────────────────────────

class MockRaceClient {
  // Apenas o subset usado por sendWithStateMachine.
  async send(_input: ZapsterSendInput): Promise<ZapsterSendResult> {
    // Pequeno jitter para garantir que ambas as chamadas concorram pelo claim.
    await new Promise((r) => setTimeout(r, 10));
    return { zapsterMessageId: 'mock-race' };
  }
  async typingIndicator(): Promise<void> {
    // no-op
  }
}

async function smoke2Race(): Promise<{ pass: boolean; details: string }> {
  console.log('\n=== Smoke 2: Race condition (2 workers, 1 mensagem) ===');

  const contactId = await ensureContact(SMOKE_PHONES[1]);
  const text = '[smoke b9 race] payload mock';
  const outboundId = await insertPendingOutbound(
    contactId,
    text,
    SMOKE_PHONES[1],
  );
  console.log('  outboundId:', outboundId);

  const client = new MockRaceClient() as unknown as ZapsterClient;
  const bus = createEventBus(outboundId, contactId, null);

  // 2 chamadas em paralelo.
  const [r1, r2] = await Promise.all([
    sendWithStateMachine(
      outboundId,
      client,
      { recipientId: SMOKE_PHONES[1], recipientType: 'chat', text },
      bus,
    ),
    sendWithStateMachine(
      outboundId,
      client,
      { recipientId: SMOKE_PHONES[1], recipientType: 'chat', text },
      bus,
    ),
  ]);
  console.log('  r1:', JSON.stringify(r1), '  r2:', JSON.stringify(r2));
  await bus.flushToDatabase();

  // Esperado: 1 sent + 1 race_lost (em qualquer ordem).
  const statuses = [r1.status, r2.status].sort();
  const expected = ['race_lost', 'sent'];
  if (
    statuses[0] !== expected[0] ||
    statuses[1] !== expected[1]
  ) {
    return {
      pass: false,
      details: `expected one sent + one race_lost, got [${statuses.join(', ')}]`,
    };
  }

  // Estado final no banco.
  const row = await readMessage(outboundId);
  if (!row) return { pass: false, details: 'outbound row not found post-race' };
  console.log('  final row:', JSON.stringify(row));

  if (row.send_status !== 'sent') {
    return {
      pass: false,
      details: `expected send_status=sent, got ${row.send_status}`,
    };
  }
  if (row.zapster_message_id !== 'mock-race') {
    return {
      pass: false,
      details: `expected zapster_message_id=mock-race, got ${row.zapster_message_id}`,
    };
  }
  if ((row.send_attempts ?? 0) !== 1) {
    return {
      pass: false,
      details: `expected send_attempts=1 (race_lost não conta), got ${row.send_attempts}`,
    };
  }
  if (!row.send_attempted_at) {
    return { pass: false, details: 'send_attempted_at NULL — invariante quebrado' };
  }

  return {
    pass: true,
    details: 'ok — 1 sent + 1 race_lost; send_attempts=1; CHECK_3 ok',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    const before = await snapshot('BEFORE');
    if (before.msgs_b9 !== 0) {
      console.error('  ✗ BEFORE state dirty (msgs_b9 > 0). Cleaning first.');
      await cleanup();
    }

    const s1 = await smoke1HappyPath();
    if (s1.skipped) {
      console.log('  ⚠ Smoke 1 SKIPPED:', s1.details);
    } else if (s1.pass) {
      console.log('  ✓ Smoke 1 PASS:', s1.details);
    } else {
      console.error('  ✗ Smoke 1 FAIL:', s1.details);
      exitCode = 1;
    }

    const s2 = await smoke2Race();
    if (s2.pass) {
      console.log('  ✓ Smoke 2 PASS:', s2.details);
    } else {
      console.error('  ✗ Smoke 2 FAIL:', s2.details);
      exitCode = 1;
    }
  } catch (err) {
    console.error(
      '\n[FATAL]',
      err instanceof Error ? err.stack : String(err),
    );
    exitCode = 1;
  } finally {
    try {
      await cleanup();
      const after = await snapshot('AFTER');
      if (after.msgs_b9 !== 0) {
        console.error(
          '  ✗ Cleanup DID NOT clear smoke rows (msgs_b9=' + after.msgs_b9 + ')',
        );
        exitCode = 1;
      } else {
        console.log('  ✓ Cleanup PASS — msgs_b9=0');
      }
    } catch (cleanupErr) {
      console.error('[CLEANUP ERROR]', cleanupErr);
      exitCode = 1;
    }
    await closeDb();
  }
  process.exit(exitCode);
}

main();
