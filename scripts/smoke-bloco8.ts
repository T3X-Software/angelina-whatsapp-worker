// scripts/smoke-bloco8.ts
//
// Bloco 8 — Smoke programático MINIMO (modo economico).
//
// 2 cenarios apenas (Sergio pediu reducao de consumo):
//   1. Happy path: 1 chamada real ao Claude com max_iterations=2.
//      - Espera: status='completed', 1 outbound com texto NAO-vazio,
//        tokens_in/out > 0, cost_usd > 0.
//   2. Fallback: ANTHROPIC_API_KEY invalido (override via process.env).
//      - Espera: status='completed' (com fallback), trace `llm_fallback_active`,
//        outbound contem agent_configs.fallback_message,
//        tokens=NULL nos relatorios.
//
// Validacao SQL: 1 SELECT antes (count agregado), 1 SELECT depois (esperar 0).
// Cleanup obrigatorio no finally.
//
// IMPORTANTE: requer .env com ANTHROPIC_API_KEY real para Smoke 1.
// Smoke 2 substitui temporariamente por chave invalida via process.env.

import 'dotenv/config';
import { sql, inArray } from 'drizzle-orm';

import { db, closeDb } from '../src/db/client';
import {
  contactPhones,
  contacts,
  leads,
  messages,
  tasks,
  timelineEvents,
  traces,
} from '../src/db/schema';

import type { WebhookPayload } from '../src/edge/payload';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildPayload(
  senderPhone: string,
  zapsterMessageId: string,
  text: string,
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
    'x-message-id': 'smoke-b8-headers',
    'x-instance-id': 'smoke-instance',
    'x-webhook-id': 'smoke-webhook',
    'x-attempt-count': '1',
    'user-agent': 'Zapsterapi/smoke',
  };
}

const SMOKE_PHONES = [
  '5500000080', // Smoke 1 — happy path
  '5500000081', // Smoke 2 — fallback
];

interface AggSnapshot {
  msgs_b8: number;
  traces_b8: number;
  total_messages: number;
  total_traces: number;
  total_contacts: number;
  total_phones: number;
  total_leads: number;
  [k: string]: unknown;
}

async function snapshot(label: string): Promise<AggSnapshot> {
  const r = await db.execute<AggSnapshot>(sql`
    SELECT
      (SELECT count(*) FROM messages WHERE zapster_message_id LIKE 'smoke-b8-%')::int AS msgs_b8,
      (SELECT count(*) FROM traces WHERE message_id IN (SELECT id FROM messages WHERE zapster_message_id LIKE 'smoke-b8-%'))::int AS traces_b8,
      (SELECT count(*) FROM messages)::int AS total_messages,
      (SELECT count(*) FROM traces)::int AS total_traces,
      (SELECT count(*) FROM contacts)::int AS total_contacts,
      (SELECT count(*) FROM contact_phones)::int AS total_phones,
      (SELECT count(*) FROM leads)::int AS total_leads
  `);
  const row = Array.from(r)[0];
  console.log(`\n[${label}]`, JSON.stringify(row));
  return row;
}

async function ensureAngelinaActiveCappedIter(): Promise<{
  wasActive: boolean;
  prevMaxIter: number;
}> {
  const r = await db.execute<{ is_active: boolean; max_iterations: number }>(sql`
    SELECT is_active, max_iterations
      FROM agent_configs WHERE key='angelina' AND version=2
  `);
  const row = Array.from(r)[0];
  const wasActive = row?.is_active === true;
  const prevMaxIter = row?.max_iterations ?? 5;
  // Cap max_iterations=2 para LIMITAR custo do smoke happy-path.
  await db.execute(sql`
    UPDATE agent_configs
       SET is_active = true, max_iterations = 2
     WHERE key='angelina' AND version=2
  `);
  return { wasActive, prevMaxIter };
}

async function restoreAngelina(wasActive: boolean, prevMaxIter: number): Promise<void> {
  await db.execute(sql`
    UPDATE agent_configs
       SET is_active = ${wasActive}, max_iterations = ${prevMaxIter}
     WHERE key='angelina' AND version=2
  `);
}

async function cleanup(): Promise<void> {
  console.log('\n[CLEANUP] starting');
  const smokeContactRows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(contactPhones, sql`${contactPhones.contactId} = ${contacts.id}`)
    .where(inArray(contactPhones.phone, SMOKE_PHONES));
  const contactIds = smokeContactRows.map((r) => r.id);
  console.log('[CLEANUP] smoke contact ids', contactIds);

  if (contactIds.length > 0) {
    await db
      .delete(timelineEvents)
      .where(inArray(timelineEvents.contactId, contactIds));
    await db.delete(tasks).where(inArray(tasks.contactId, contactIds));
    await db.delete(traces).where(inArray(traces.contactId, contactIds));
    await db.delete(messages).where(inArray(messages.contactId, contactIds));
    await db.delete(leads).where(inArray(leads.contactId, contactIds));
    await db
      .delete(contactPhones)
      .where(inArray(contactPhones.contactId, contactIds));
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
  console.log('[CLEANUP] done');
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke 1 — Happy path
// ─────────────────────────────────────────────────────────────────────────────

async function smoke1HappyPath(): Promise<{ pass: boolean; details: string }> {
  console.log('\n=== Smoke 1: Happy path (1 chamada real ao Claude) ===');
  // Lazy import APOS dotenv ja carregado.
  const { run: harnessRun } = await import('../src/harness/loop');

  const phone = SMOKE_PHONES[0];
  const zid = 'smoke-b8-msg-001';
  const payload = buildPayload(
    phone,
    zid,
    'Olá! Queria informações sobre casamento aí no espaço.',
  );
  const headers = buildHeaders();

  const result = await harnessRun(payload, headers);
  console.log('  result:', JSON.stringify(result));

  if (result.status !== 'completed') {
    return { pass: false, details: `expected completed, got ${result.status} (reason=${result.reason ?? '-'})` };
  }
  if (!result.outboundMessageId) {
    return { pass: false, details: 'no outboundMessageId' };
  }

  // Validar tokens_in, tokens_out, cost_usd > 0 no outbound real.
  const r = await db.execute<{
    text: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: string | null;
    send_status: string | null;
  }>(sql`
    SELECT text, tokens_in, tokens_out, cost_usd::text AS cost_usd, send_status::text AS send_status
      FROM messages WHERE id = ${result.outboundMessageId}
  `);
  const row = Array.from(r)[0];
  if (!row) return { pass: false, details: 'outbound row not found' };
  console.log('  outbound row:', JSON.stringify(row));

  if (!row.text || row.text.length < 5) {
    return { pass: false, details: `outbound text empty/too short (len=${row.text?.length ?? 0})` };
  }
  if (!row.tokens_in || row.tokens_in <= 0) {
    return { pass: false, details: `tokens_in not > 0 (got ${row.tokens_in})` };
  }
  if (!row.tokens_out || row.tokens_out <= 0) {
    return { pass: false, details: `tokens_out not > 0 (got ${row.tokens_out})` };
  }
  if (!row.cost_usd || Number(row.cost_usd) <= 0) {
    return { pass: false, details: `cost_usd not > 0 (got ${row.cost_usd})` };
  }
  if (row.send_status !== 'sent') {
    return { pass: false, details: `expected send_status=sent (Bloco 9 ainda STUB sender), got ${row.send_status}` };
  }

  return {
    pass: true,
    details: `ok — text_len=${row.text.length}, tokens_in=${row.tokens_in}, tokens_out=${row.tokens_out}, cost_usd=${row.cost_usd}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke 2 — Fallback (chave invalida)
// ─────────────────────────────────────────────────────────────────────────────

async function smoke2Fallback(): Promise<{ pass: boolean; details: string }> {
  console.log('\n=== Smoke 2: Fallback (ANTHROPIC_API_KEY invalido) ===');
  // Override em process.env e re-import dinamico do loop+anthropic.
  // Como env.ts esta no top do anthropic.ts, precisamos garantir que o
  // singleton _client recrie. anthropic.ts ja recria quando env.ANTHROPIC_API_KEY
  // muda — mas env eh CONST. Workaround: reescrever process.env e re-importar
  // o modulo env (cache delete).

  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-invalid-test-key-bloco8-smoke';

  // Re-importar: precisamos limpar o cache do require para que env.ts re-execute.
  // tsx usa ESM em runtime — cache busting via query string no import.
  const cacheBuster = `?bust=${Date.now()}`;
  // O loop.ts importa env via callClaude ('../env'). Re-importar loop com bust.
  // Como tsx faz transpile on the fly, tentamos primeiro com imports normais —
  // se falhar, fazemos requestes diretos via API SDK invalida.
  try {
    const envMod = await import('../src/env' + cacheBuster);
    console.log('  env reload OK; current ANTHROPIC_API_KEY suffix:',
      (envMod.env.ANTHROPIC_API_KEY ?? '').slice(-10));
  } catch (e) {
    console.log('  env re-import skipped:', String(e));
  }

  const { run: harnessRun } = await import('../src/harness/loop' + cacheBuster);

  const phone = SMOKE_PHONES[1];
  const zid = 'smoke-b8-msg-002';
  const payload = buildPayload(
    phone,
    zid,
    'Quero saber sobre o espaço para um aniversário.',
  );
  const headers = buildHeaders();

  let result;
  try {
    result = await harnessRun(payload, headers);
    console.log('  result:', JSON.stringify(result));
  } finally {
    // Restore key imediatamente.
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }

  if (result.status !== 'completed') {
    return { pass: false, details: `expected completed, got ${result.status} (reason=${result.reason ?? '-'})` };
  }
  if (!result.outboundMessageId) {
    return { pass: false, details: 'no outboundMessageId' };
  }

  // Confirmar trace llm_fallback_active.
  const traceRows = await db.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`
    SELECT event_type, payload
      FROM traces
     WHERE message_id = ${result.inboundMessageId}
       AND event_type = 'llm_fallback_active'
  `);
  const traceArr = Array.from(traceRows);
  if (traceArr.length === 0) {
    return { pass: false, details: 'trace llm_fallback_active not found' };
  }
  console.log('  fallback trace:', JSON.stringify(traceArr[0]));

  // Confirmar texto do outbound = fallback_message.
  const r = await db.execute<{
    text: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: string | null;
  }>(sql`
    SELECT text, tokens_in, tokens_out, cost_usd::text AS cost_usd
      FROM messages WHERE id = ${result.outboundMessageId}
  `);
  const row = Array.from(r)[0];
  console.log('  outbound row:', JSON.stringify(row));

  // Buscar fallback_message da config para comparar.
  const cfg = await db.execute<{ fallback_message: string | null }>(sql`
    SELECT fallback_message FROM agent_configs WHERE key='angelina' AND version=2
  `);
  const fb = Array.from(cfg)[0]?.fallback_message ?? '';
  if (!row.text || !row.text.includes(fb.slice(0, 30))) {
    return {
      pass: false,
      details: `outbound text does not match fallback_message. got=${(row.text ?? '').slice(0, 80)} expected~=${fb.slice(0, 80)}`,
    };
  }
  if (row.tokens_in !== null || row.tokens_out !== null || row.cost_usd !== null) {
    return {
      pass: false,
      details: `expected tokens_in/out/cost_usd=NULL in fallback. got tokens_in=${row.tokens_in} tokens_out=${row.tokens_out} cost_usd=${row.cost_usd}`,
    };
  }

  return { pass: true, details: 'ok — fallback emitted, text matches fallback_message, tokens NULL' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let cfgState: { wasActive: boolean; prevMaxIter: number } | null = null;
  const results: Array<{ name: string; pass: boolean; details: string }> = [];

  try {
    const before = await snapshot('BEFORE');
    cfgState = await ensureAngelinaActiveCappedIter();

    // Smoke 1 — happy path
    try {
      const r = await smoke1HappyPath();
      results.push({ name: 'Smoke 1 (happy path)', ...r });
    } catch (e) {
      results.push({
        name: 'Smoke 1 (happy path)',
        pass: false,
        details: `THREW: ${String(e instanceof Error ? e.stack ?? e.message : e)}`,
      });
    }

    // Smoke 2 — fallback
    try {
      const r = await smoke2Fallback();
      results.push({ name: 'Smoke 2 (fallback)', ...r });
    } catch (e) {
      results.push({
        name: 'Smoke 2 (fallback)',
        pass: false,
        details: `THREW: ${String(e instanceof Error ? e.stack ?? e.message : e)}`,
      });
    }

    const mid = await snapshot('MID (pre-cleanup)');
    void mid;
  } finally {
    try {
      await cleanup();
    } catch (e) {
      console.error('[CLEANUP] error:', e);
    }
    if (cfgState) {
      await restoreAngelina(cfgState.wasActive, cfgState.prevMaxIter);
    }
    const after = await snapshot('AFTER');

    console.log('\n=== RESULTS ===');
    for (const r of results) {
      console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}: ${r.details}`);
    }

    const allPass = results.every((r) => r.pass);
    console.log(`\n=== ${allPass ? 'ALL PASS' : 'SOME FAIL'} ===`);

    // Sanity check: AFTER deve casar BEFORE (smoke contagens).
    if (after.msgs_b8 !== 0 || after.traces_b8 !== 0) {
      console.error('CLEANUP CHECK FAIL — leftover smoke rows', after);
    } else {
      console.log('CLEANUP CHECK PASS — msgs_b8=0, traces_b8=0');
    }

    await closeDb();
    if (!allPass) process.exit(1);
  }
}

main().catch((e) => {
  console.error('TOP LEVEL ERROR', e);
  closeDb().finally(() => process.exit(1));
});
