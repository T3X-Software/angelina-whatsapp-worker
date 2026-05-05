// scripts/smoke-bloco6.ts
//
// Bloco 6 — Smoke programático dos 6 hooks reais + integração com loop.ts.
//
// Cenários:
//   A. Happy path — todos hooks rodam sem short-circuit (5500000010,
//      smoke-b6-msg-001). Esperar status=completed, 1 inbound, 1 outbound,
//      traces de TODOS os 6 hooks (rate-limit, admin, load-context,
//      transfer-trigger, format-whatsapp, human-delay, response-guard).
//   B. Rate-limit-guard — 31 INBOUND fake pré-inseridas (5500000011) →
//      `rate_limit_hit` short-circuita o turno antes do INSERT outbound.
//   C. Admin-router /pausar — 5500000012 em `admin_phones` (toggle temporário
//      no agent_configs.hookParams). UPDATE `contacts.ai_state='PAUSED'`,
//      trace `admin_command_executed`, status=`short_circuit` em BEFORE_REQUEST.
//   D. Transfer-trigger HOT handoff — 5500000013 com lead pré-criado
//      (WEDDING / 2026-12-15 / 200 / HOT). Forçar `HARNESS_FORCE_HANDOFF=1`
//      OU `text='/__trigger_handoff__'`. Esperar 5 efeitos:
//        1. leads.is_human_active=true,
//        2. INSERT tasks ('Lead HOT — atendimento'),
//        3. INSERT timeline_events ('Handoff HOT'),
//        4. trace `handoff_complete`,
//        5. trace `support_whatsapp_unset` (porque support_whatsapp='').
//      format-whatsapp NÃO roda (transfer fez short-circuit).
//   E. Response-guard PAUSED — 5500000014 com ai_state='PAUSED' pré-setado.
//      Loop chega até INSERT outbound (pending), response-guard re-lê e bloqueia
//      → status=short_circuit em BEFORE_SEND, trace `send_blocked`,
//      outbound atualizado para 'failed'.
//   F. format-whatsapp — assert programático sobre transformações puras
//      (sem loop, sem DB).
//   G. human-delay — assert que o delay é proporcional ao tamanho do texto
//      (clamp 1000-5000ms).
//
// Ground-truth via SQL antes/depois. Cleanup obrigatório no finally.

import 'dotenv/config';
import { sql, inArray, eq } from 'drizzle-orm';
import pino from 'pino';

import { db, closeDb } from '../src/db/client';
import {
  contactPhones,
  contacts,
  leads,
  messages,
  pipelineColumns,
  tasks,
  timelineEvents,
  traces,
} from '../src/db/schema';
import { run as harnessRun } from '../src/harness/loop';
import type { WebhookPayload } from '../src/edge/payload';

import { formatWhatsappText } from '../src/hooks/format-whatsapp';
import { computeHumanDelayMs, createHumanDelayHook } from '../src/hooks/human-delay';
import { ZapsterClient } from '../src/zapster/client';
import type { HarnessContext, EventBus } from '../src/harness/types';

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
    'x-message-id': 'smoke-b6-headers',
    'x-instance-id': 'smoke-instance',
    'x-webhook-id': 'smoke-webhook',
    'x-attempt-count': '1',
    'user-agent': 'Zapsterapi/smoke',
  };
}

const SMOKE_PHONES = [
  '5500000010', // A — happy path
  '5500000011', // B — rate-limit
  '5500000012', // C — admin-router
  '5500000013', // D — HOT handoff
  '5500000014', // E — response-guard PAUSED
];
const SMOKE_ZAPSTER_PREFIX = 'smoke-b6-';

interface Snapshot {
  msgs_b6: number;
  traces_b6: number;
  tasks_hot: number;
  tl_hot: number;
  total_messages: number;
  total_traces: number;
  total_contacts: number;
  total_phones: number;
  total_tasks: number;
  total_tl: number;
  total_leads: number;
  [k: string]: unknown;
}

async function snapshot(label: string): Promise<Snapshot> {
  const r = await db.execute<Snapshot>(sql`
    SELECT
      (SELECT count(*) FROM messages WHERE zapster_message_id LIKE 'smoke-b6-%')::int AS msgs_b6,
      (SELECT count(*) FROM traces WHERE message_id IN (SELECT id FROM messages WHERE zapster_message_id LIKE 'smoke-b6-%'))::int AS traces_b6,
      (SELECT count(*) FROM tasks WHERE title='Lead HOT — atendimento')::int AS tasks_hot,
      (SELECT count(*) FROM timeline_events WHERE title='Handoff HOT')::int AS tl_hot,
      (SELECT count(*) FROM messages)::int AS total_messages,
      (SELECT count(*) FROM traces)::int AS total_traces,
      (SELECT count(*) FROM contacts)::int AS total_contacts,
      (SELECT count(*) FROM contact_phones)::int AS total_phones,
      (SELECT count(*) FROM tasks)::int AS total_tasks,
      (SELECT count(*) FROM timeline_events)::int AS total_tl,
      (SELECT count(*) FROM leads)::int AS total_leads
  `);
  const row = Array.from(r)[0];
  console.log(`\n[${label}]`, JSON.stringify(row));
  return row;
}

async function cleanup(): Promise<void> {
  console.log('\n[CLEANUP] starting');
  // 1) IDs dos contatos de smoke (criados ou pré-existentes).
  const smokeContactRows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(contactPhones, eq(contactPhones.contactId, contacts.id))
    .where(inArray(contactPhones.phone, SMOKE_PHONES));
  const contactIds = smokeContactRows.map((r) => r.id);
  console.log('[CLEANUP] smoke contact ids', contactIds);

  if (contactIds.length > 0) {
    // 2) Apaga timeline_events ligados aos contatos do smoke (smoke D cria
    //    'Handoff HOT'; outros podem criar via tools — defesa em profundidade).
    const delTl = await db
      .delete(timelineEvents)
      .where(inArray(timelineEvents.contactId, contactIds))
      .returning({ id: timelineEvents.id });
    console.log('[CLEANUP] timeline_events deleted', delTl.length);

    // 3) Apaga tasks (mesma justificativa).
    const delTasks = await db
      .delete(tasks)
      .where(inArray(tasks.contactId, contactIds))
      .returning({ id: tasks.id });
    console.log('[CLEANUP] tasks deleted', delTasks.length);

    // 4) Apaga traces ligados a contatos.
    const delTraces = await db
      .delete(traces)
      .where(inArray(traces.contactId, contactIds))
      .returning({ id: traces.id });
    console.log('[CLEANUP] traces deleted', delTraces.length);

    // 5) Apaga messages.
    const delMsgs = await db
      .delete(messages)
      .where(inArray(messages.contactId, contactIds))
      .returning({ id: messages.id });
    console.log('[CLEANUP] messages deleted', delMsgs.length);

    // 6) Apaga leads.
    const delLeads = await db
      .delete(leads)
      .where(inArray(leads.contactId, contactIds))
      .returning({ id: leads.id });
    console.log('[CLEANUP] leads deleted', delLeads.length);

    // 7) Apaga contact_phones.
    const delPhones = await db
      .delete(contactPhones)
      .where(inArray(contactPhones.contactId, contactIds))
      .returning({ id: contactPhones.id });
    console.log('[CLEANUP] contact_phones deleted', delPhones.length);

    // 8) Apaga contacts.
    const delContacts = await db
      .delete(contacts)
      .where(inArray(contacts.id, contactIds))
      .returning({ id: contacts.id });
    console.log('[CLEANUP] contacts deleted', delContacts.length);
  }

  // 9) Defesa-em-profundidade: orphans por zapster_id smoke-b6-*.
  const orphanMsgs = await db
    .delete(messages)
    .where(sql`zapster_message_id LIKE ${SMOKE_ZAPSTER_PREFIX + '%'}`)
    .returning({ id: messages.id });
  if (orphanMsgs.length > 0) {
    console.log('[CLEANUP] orphan messages by zapster_id deleted', orphanMsgs.length);
  }
  // 10) Outbound stub-* das últimas 15 min (zapster_message_id começa com `stub-`
  //     ou `mock-` — Bloco 5 deixou mock; Bloco 6 send é mock interno do loop).
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
// Setup específico para cada cenário
// ─────────────────────────────────────────────────────────────────────────────

/** Pré-cria 31 INBOUND fake para o contato (rate-limit-guard). */
async function preInsert31Inbounds(contactId: string): Promise<void> {
  const rows = Array.from({ length: 31 }, (_, i) => ({
    contactId,
    direction: 'INBOUND' as const,
    role: 'user' as const,
    text: `pre-inbound ${i + 1}`,
    zapsterMessageId: `smoke-b6-pre-${i + 1}`,
  }));
  await db.insert(messages).values(rows);
}

/** Toggle agent_configs.hookParams.admin_phones para incluir um phone. */
async function setAdminPhones(phones: string[]): Promise<unknown> {
  // Salva o valor anterior para restore.
  const prev = await db.execute<{ admin_phones: unknown }>(sql`
    SELECT hook_params->'admin_phones' AS admin_phones
      FROM agent_configs WHERE key='angelina' AND version=2
  `);
  const prevAdminPhones = Array.from(prev)[0]?.admin_phones ?? [];
  await db.execute(sql`
    UPDATE agent_configs
       SET hook_params = jsonb_set(hook_params, '{admin_phones}', ${JSON.stringify(phones)}::jsonb)
     WHERE key='angelina' AND version=2
  `);
  return prevAdminPhones;
}

async function restoreAdminPhones(prev: unknown): Promise<void> {
  await db.execute(sql`
    UPDATE agent_configs
       SET hook_params = jsonb_set(hook_params, '{admin_phones}', ${JSON.stringify(prev ?? [])}::jsonb)
     WHERE key='angelina' AND version=2
  `);
}

/**
 * Pré-cria contact + lead HOT com event_type/date/guest_count para Smoke D.
 */
async function preCreateHotLead(phone: string): Promise<{
  contactId: string;
  leadId: string;
}> {
  // Pega ENTRY pipeline column.
  const entryRows = await db
    .select({ id: pipelineColumns.id })
    .from(pipelineColumns)
    .where(eq(pipelineColumns.type, 'ENTRY'))
    .limit(1);
  if (entryRows.length === 0) {
    throw new Error('preCreateHotLead: no ENTRY pipeline_column found');
  }
  const entryId = entryRows[0].id;

  // Cria contact.
  const [c] = await db
    .insert(contacts)
    .values({
      name: `WhatsApp ${phone}`,
      origin: 'WhatsApp',
      aiState: 'AUTO',
    })
    .returning({ id: contacts.id });
  await db.insert(contactPhones).values({
    contactId: c.id,
    phone,
    type: 'mobile',
    isPrimary: true,
    isWhatsapp: true,
  });

  // Cria lead HOT com 3 dados obrigatórios.
  const [l] = await db
    .insert(leads)
    .values({
      contactId: c.id,
      pipelineColumnId: entryId,
      classification: 'HOT',
      eventType: 'WEDDING',
      eventDate: '2026-12-15',
      guestCount: 200,
      origin: 'WhatsApp',
    })
    .returning({ id: leads.id });

  return { contactId: c.id, leadId: l.id };
}

/** Pré-cria contact + lead com ai_state='PAUSED' para Smoke E. */
async function preCreatePausedContact(phone: string): Promise<string> {
  const [c] = await db
    .insert(contacts)
    .values({
      name: `WhatsApp ${phone}`,
      origin: 'WhatsApp',
      aiState: 'PAUSED',
    })
    .returning({ id: contacts.id });
  await db.insert(contactPhones).values({
    contactId: c.id,
    phone,
    type: 'mobile',
    isPrimary: true,
    isWhatsapp: true,
  });
  return c.id;
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
  const phone = '5500000010';
  const zapMsgId = 'smoke-b6-msg-001';
  console.log(`\n=== Smoke A — Happy path (${phone}, ${zapMsgId}) ===`);

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, 'olá Angelina'),
    buildHeaders(),
  );
  console.log('  result:', result);

  const inboundQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE zapster_message_id = ${zapMsgId} AND direction='INBOUND'
  `);
  const inboundCount = Array.from(inboundQ)[0].count;

  const outboundQ = await db.execute<{
    count: number;
    mock_zid: string | null;
    [k: string]: unknown;
  }>(sql`
    SELECT count(*)::int AS count, max(zapster_message_id) AS mock_zid
      FROM messages
     WHERE id = ${result.outboundMessageId ?? '00000000-0000-0000-0000-000000000000'}
       AND direction='OUTBOUND' AND send_status='sent'
  `);
  const outboundRow = Array.from(outboundQ)[0];

  // Tipos de trace esperados (todos os 6 hooks emitem `hook_<name>`):
  const tracesQ = await db.execute<{
    count: number;
    types: string[];
    [k: string]: unknown;
  }>(sql`
    SELECT count(*)::int AS count, array_agg(distinct event_type) AS types
      FROM traces
     WHERE message_id = ${result.inboundMessageId ?? '00000000-0000-0000-0000-000000000000'}
  `);
  const tracesRow = Array.from(tracesQ)[0];
  const types = tracesRow.types ?? [];

  const expectedHookTraces = [
    'hook_rate-limit-guard',
    'hook_admin-router', // admin-router NÃO emite hook trace quando o phone não é admin (return {} sem trace)
    'memory_loaded_stub',
    'hook_transfer-trigger',
    'hook_format-whatsapp',
    'human_delay_applied',
    'hook_response-guard',
  ];
  // admin-router NÃO emite trace quando não bate regex e phone fora de whitelist.
  // Aceita os outros 6.
  const required = [
    'hook_rate-limit-guard',
    'memory_loaded_stub',
    'hook_transfer-trigger',
    'hook_format-whatsapp',
    'human_delay_applied',
    'hook_response-guard',
    'turn_complete',
  ];
  const missing = required.filter((t) => !types.includes(t));

  const pass =
    result.status === 'completed' &&
    inboundCount === 1 &&
    outboundRow.count === 1 &&
    typeof outboundRow.mock_zid === 'string' &&
    outboundRow.mock_zid.startsWith('mock-') &&
    missing.length === 0;

  return {
    name: 'A — happy path',
    status: result.status,
    pass,
    details: {
      inboundCount,
      outboundCount: outboundRow.count,
      outboundMockZid: outboundRow.mock_zid,
      tracesCount: tracesRow.count,
      tracesTypes: types,
      missing,
      expectedHookTraces,
    },
  };
}

async function smokeB(): Promise<CaseResult> {
  const phone = '5500000011';
  const zapMsgId = 'smoke-b6-msg-002';
  console.log(`\n=== Smoke B — rate-limit-guard (${phone}, ${zapMsgId}) ===`);

  // Cria contact primeiro.
  const [c] = await db
    .insert(contacts)
    .values({
      name: `WhatsApp ${phone}`,
      origin: 'WhatsApp',
      aiState: 'AUTO',
    })
    .returning({ id: contacts.id });
  await db.insert(contactPhones).values({
    contactId: c.id,
    phone,
    type: 'mobile',
    isPrimary: true,
    isWhatsapp: true,
  });

  // Pré-insere 31 INBOUND para passar do limite (default 30).
  await preInsert31Inbounds(c.id);

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, '32ª mensagem'),
    buildHeaders(),
  );
  console.log('  result:', result);

  // Trace `rate_limit_hit` deve estar presente.
  const traceQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM traces
     WHERE contact_id = ${c.id}
       AND event_type = 'rate_limit_hit'
  `);
  const traceCount = Array.from(traceQ)[0].count;

  // outbound NÃO deve ter sido criado (curto-circuito em BEFORE_REQUEST).
  const outboundQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE contact_id = ${c.id} AND direction = 'OUTBOUND'
  `);
  const outboundCount = Array.from(outboundQ)[0].count;

  const pass =
    result.status === 'short_circuit' &&
    typeof result.reason === 'string' &&
    result.reason.includes('rate-limit-guard') &&
    traceCount >= 1 &&
    outboundCount === 0;

  return {
    name: 'B — rate-limit-guard',
    status: result.status,
    pass,
    details: {
      reason: result.reason,
      traceCount,
      outboundCount,
    },
  };
}

async function smokeC(): Promise<CaseResult> {
  const phone = '5500000012';
  const zapMsgId = 'smoke-b6-msg-003';
  console.log(`\n=== Smoke C — admin-router /pausar (${phone}, ${zapMsgId}) ===`);

  // Cria contact.
  const [c] = await db
    .insert(contacts)
    .values({
      name: `WhatsApp ${phone}`,
      origin: 'WhatsApp',
      aiState: 'AUTO',
    })
    .returning({ id: contacts.id });
  await db.insert(contactPhones).values({
    contactId: c.id,
    phone,
    type: 'mobile',
    isPrimary: true,
    isWhatsapp: true,
  });

  // Toggle admin_phones temporário.
  const prevAdminPhones = await setAdminPhones([phone]);

  let result;
  try {
    result = await harnessRun(buildPayload(phone, zapMsgId, '/pausar'), buildHeaders());
    console.log('  result:', result);
  } finally {
    await restoreAdminPhones(prevAdminPhones);
  }

  // ai_state deve ser PAUSED agora.
  const stateQ = await db.execute<{ ai_state: string; [k: string]: unknown }>(sql`
    SELECT ai_state FROM contacts WHERE id = ${c.id}
  `);
  const aiState = Array.from(stateQ)[0]?.ai_state;

  // Trace `admin_command_executed` presente.
  const traceQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM traces
     WHERE contact_id = ${c.id}
       AND event_type = 'admin_command_executed'
  `);
  const traceCount = Array.from(traceQ)[0].count;

  // Outbound NÃO criado (short-circuit em BEFORE_REQUEST).
  const outboundQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE contact_id = ${c.id} AND direction = 'OUTBOUND'
  `);
  const outboundCount = Array.from(outboundQ)[0].count;

  const pass =
    result.status === 'short_circuit' &&
    aiState === 'PAUSED' &&
    traceCount >= 1 &&
    outboundCount === 0;

  return {
    name: 'C — admin-router /pausar',
    status: result.status,
    pass,
    details: { aiState, traceCount, outboundCount, reason: result.reason },
  };
}

async function smokeD(): Promise<CaseResult> {
  const phone = '5500000013';
  const zapMsgId = 'smoke-b6-msg-004';
  console.log(`\n=== Smoke D — transfer-trigger HOT handoff (${phone}, ${zapMsgId}) ===`);

  // Pré-cria contact + lead HOT.
  const { contactId, leadId } = await preCreateHotLead(phone);

  // Forçar handoff via env var (lido pelo loop).
  process.env.HARNESS_FORCE_HANDOFF = '1';

  let result;
  try {
    result = await harnessRun(
      buildPayload(phone, zapMsgId, 'já decidi, quero contratar'),
      buildHeaders(),
    );
    console.log('  result:', result);
  } finally {
    delete process.env.HARNESS_FORCE_HANDOFF;
  }

  // 1. is_human_active=true.
  const leadQ = await db.execute<{ is_human_active: boolean; [k: string]: unknown }>(sql`
    SELECT is_human_active FROM leads WHERE id = ${leadId}
  `);
  const isHumanActive = Array.from(leadQ)[0]?.is_human_active === true;

  // 2. INSERT tasks.
  const taskQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM tasks
     WHERE lead_id = ${leadId} AND title='Lead HOT — atendimento'
  `);
  const tasksCount = Array.from(taskQ)[0].count;

  // 3. INSERT timeline_events.
  const tlQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM timeline_events
     WHERE lead_id = ${leadId} AND title='Handoff HOT'
  `);
  const tlCount = Array.from(tlQ)[0].count;

  // 4. Trace `handoff_complete` presente.
  // 5. Trace `support_whatsapp_unset` (porque agent_configs.support_whatsapp='').
  const tracesQ = await db.execute<{ types: string[]; [k: string]: unknown }>(sql`
    SELECT array_agg(event_type) AS types FROM traces
     WHERE contact_id = ${contactId}
  `);
  const traceTypes = (Array.from(tracesQ)[0]?.types ?? []) as string[];
  const hasHandoffComplete = traceTypes.includes('handoff_complete');
  const hasSupportUnset = traceTypes.includes('support_whatsapp_unset');
  // format-whatsapp NÃO deve ter rodado (transfer cortou o AFTER_MODEL).
  const hasFormatWhatsapp = traceTypes.includes('hook_format-whatsapp');

  // outbound NÃO deve existir (transfer cortou antes do INSERT outbound).
  const outboundQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE contact_id = ${contactId} AND direction = 'OUTBOUND'
  `);
  const outboundCount = Array.from(outboundQ)[0].count;

  const pass =
    result.status === 'short_circuit' &&
    isHumanActive &&
    tasksCount === 1 &&
    tlCount === 1 &&
    hasHandoffComplete &&
    hasSupportUnset &&
    !hasFormatWhatsapp &&
    outboundCount === 0;

  return {
    name: 'D — transfer-trigger HOT handoff',
    status: result.status,
    pass,
    details: {
      isHumanActive,
      tasksCount,
      tlCount,
      hasHandoffComplete,
      hasSupportUnset,
      hasFormatWhatsapp_shouldBeFalse: hasFormatWhatsapp,
      outboundCount,
      traceTypes,
    },
  };
}

async function smokeE(): Promise<CaseResult> {
  const phone = '5500000014';
  const zapMsgId = 'smoke-b6-msg-005';
  console.log(`\n=== Smoke E — response-guard PAUSED (${phone}, ${zapMsgId}) ===`);

  const contactId = await preCreatePausedContact(phone);

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, 'oi'),
    buildHeaders(),
  );
  console.log('  result:', result);

  // Outbound foi inserido como pending mas response-guard bloqueou e marcou failed.
  const outboundQ = await db.execute<{
    count: number;
    send_status: string | null;
    [k: string]: unknown;
  }>(sql`
    SELECT count(*)::int AS count, max(send_status::text) AS send_status
      FROM messages
     WHERE contact_id = ${contactId} AND direction='OUTBOUND'
  `);
  const outboundRow = Array.from(outboundQ)[0];

  const blockedQ = await db.execute<{ count: number; [k: string]: unknown }>(sql`
    SELECT count(*)::int AS count FROM traces
     WHERE contact_id = ${contactId}
       AND event_type = 'send_blocked'
       AND payload->>'reason' = 'ai_state=PAUSED'
  `);
  const blockedCount = Array.from(blockedQ)[0].count;

  const pass =
    result.status === 'short_circuit' &&
    outboundRow.count === 1 &&
    outboundRow.send_status === 'failed' &&
    blockedCount === 1;

  return {
    name: 'E — response-guard PAUSED',
    status: result.status,
    pass,
    details: {
      reason: result.reason,
      outboundCount: outboundRow.count,
      outboundSendStatus: outboundRow.send_status,
      blockedCount,
    },
  };
}

function smokeF(): CaseResult {
  console.log('\n=== Smoke F — format-whatsapp (puro) ===');
  const cases: Array<{ in: string; expected: string; label: string }> = [
    { in: '**Visite** nosso site', expected: '*Visite* nosso site', label: 'bold' },
    { in: '*importante*', expected: '_importante_', label: 'italic' },
    { in: '## Título', expected: 'Título', label: 'header h2' },
    { in: '### Sub', expected: 'Sub', label: 'header h3' },
    { in: '- item 1\n- item 2', expected: '• item 1\n• item 2', label: 'list dash' },
    { in: '* item A\n* item B', expected: '• item A\n• item B', label: 'list star' },
    {
      in: 'Veja https://espacoangelinos.com.br/agendar?utm_source=lua aqui',
      expected: 'Veja https://espacoangelinos.com.br/agendar?utm_source=lua aqui',
      label: 'url preserved',
    },
    {
      in: '**Bold** e *italic* juntos',
      expected: '*Bold* e _italic_ juntos',
      label: 'bold + italic',
    },
  ];

  const failures: string[] = [];
  for (const c of cases) {
    const got = formatWhatsappText(c.in);
    if (got !== c.expected) {
      failures.push(`[${c.label}] in=${JSON.stringify(c.in)} expected=${JSON.stringify(c.expected)} got=${JSON.stringify(got)}`);
    }
  }

  return {
    name: 'F — format-whatsapp (puro)',
    status: failures.length === 0 ? 'pass' : 'fail',
    pass: failures.length === 0,
    details: { failures, total: cases.length },
  };
}

async function smokeG(): Promise<CaseResult> {
  console.log('\n=== Smoke G — human-delay (timing) ===');

  // Asserts puros sobre `computeHumanDelayMs`.
  const tests: Array<{ text: string; expected: number; label: string }> = [
    { text: '', expected: 1000, label: 'empty → MIN' },
    { text: 'a', expected: 1000, label: '1 char → MIN (clamp)' },
    { text: 'a'.repeat(199), expected: 1000, label: '199 chars → still MIN (995ms<1000)' },
    { text: 'a'.repeat(200), expected: 1000, label: '200 chars → exactly 1000' },
    { text: 'a'.repeat(500), expected: 2500, label: '500 chars → 2500' },
    { text: 'a'.repeat(1000), expected: 5000, label: '1000 chars → MAX (5000)' },
    { text: 'a'.repeat(2000), expected: 5000, label: '2000 chars → still MAX (clamp)' },
  ];
  const computeFailures: string[] = [];
  for (const t of tests) {
    const got = computeHumanDelayMs(t.text);
    if (got !== t.expected) {
      computeFailures.push(`[${t.label}] expected=${t.expected} got=${got}`);
    }
  }

  // Teste de timing: roda o hook com texto curto e mede latência (alvo 1000ms).
  const logger = pino({ level: 'silent' });
  const client = new ZapsterClient(logger);
  const hook = createHumanDelayHook(client);
  const eventBus: EventBus = {
    events: [],
    emit() {},
    emitHook() {},
    emitTool() {},
    bindMessageId() {},
    async flushToDatabase() {
      return { inserted: 0 };
    },
  } as unknown as EventBus;
  const ctx: HarnessContext = {
    turn: { id: 'smoke-g-turn', startedAt: Date.now() },
    contact: { id: 'smoke-g-contact', phone: '5500000099', aiState: 'AUTO' },
    lead: null,
    message: {
      inboundId: 'smoke-g-inbound',
      zapsterMessageId: 'smoke-g-zid',
      text: 'oi',
      type: 'text',
    },
    config: null,
    payload: buildPayload('5500000099', 'smoke-g-zid', 'oi'),
    headers: {},
    eventBus,
    lastModelText: 'oi',
    responseToSend: 'oi',
  };
  const t0 = Date.now();
  await hook.run(ctx);
  const elapsed = Date.now() - t0;
  // Tolerância 200ms (sugerido no brief).
  const timingOk = elapsed >= 1000 - 50 && elapsed <= 1000 + 200;

  const pass = computeFailures.length === 0 && timingOk;
  return {
    name: 'G — human-delay',
    status: pass ? 'pass' : 'fail',
    pass,
    details: {
      computeFailures,
      timing_ms: elapsed,
      timingOk,
      tests_total: tests.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Smoke Bloco 6 — 6 hooks reais\n');

  const before = await snapshot('SNAPSHOT BEFORE');

  // Salvar estado de is_active.
  const initialActiveQ = await db.execute<{
    version: number;
    is_active: boolean;
    [k: string]: unknown;
  }>(sql`
    SELECT version, is_active FROM agent_configs
     WHERE key='angelina' ORDER BY version
  `);
  const initialActive = Array.from(initialActiveQ);
  console.log('[STATE] agent_configs.angelina inicial:', initialActive);

  const results: CaseResult[] = [];
  let exitCode = 0;
  try {
    // Ativar Angelina v2 para os smokes que precisam de loop ativo.
    await db.execute(sql`
      UPDATE agent_configs SET is_active = (version = 2)
       WHERE key='angelina'
    `);
    console.log('[STATE] Angelina v2 toggled is_active=true (smoke window)');

    results.push(await smokeA());
    results.push(await smokeB());
    results.push(await smokeC());
    results.push(await smokeD());
    results.push(await smokeE());
    results.push(smokeF());
    results.push(await smokeG());

    const mid = await snapshot('SNAPSHOT MID (post-smokes, pre-cleanup)');
    void mid;

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
    // Restaurar estado de is_active SEMPRE.
    try {
      await db.execute(sql`
        UPDATE agent_configs SET is_active=false WHERE key='angelina'
      `);
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
    const after = await snapshot('SNAPSHOT AFTER (post-cleanup)');

    // Comparação inicial vs final — ground-truth via SQL.
    const fields: Array<keyof Snapshot> = [
      'msgs_b6',
      'traces_b6',
      'tasks_hot',
      'tl_hot',
      'total_messages',
      'total_traces',
      'total_contacts',
      'total_phones',
      'total_tasks',
      'total_tl',
      'total_leads',
    ];
    const drift: Record<string, { before: unknown; after: unknown }> = {};
    for (const f of fields) {
      if (before[f] !== after[f]) {
        drift[String(f)] = { before: before[f], after: after[f] };
      }
    }
    if (Object.keys(drift).length === 0) {
      console.log('\n[GROUND-TRUTH] snapshot AFTER === snapshot BEFORE ✓');
    } else {
      console.error('\n[GROUND-TRUTH] DRIFT detected:', JSON.stringify(drift, null, 2));
      exitCode = exitCode === 0 ? 3 : exitCode;
    }

    await closeDb();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Unhandled error in main:', err);
  process.exit(2);
});
