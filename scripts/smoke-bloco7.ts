// scripts/smoke-bloco7.ts
//
// Bloco 7 — Smoke programático das 4 tools reais + integração com loop.ts
// (mockToolCalls injetável).
//
// Cenários:
//   A. Registry — getToolByName / getEnabledTools com typo logam warn.
//   B. save_lead_info novo lead — contact sem lead → cria lead na ENTRY +
//      timeline_event LEAD_UPDATED + ctx.lead populado.
//   C. save_lead_info update — contact com lead pré-criado → UPDATE +
//      1 timeline_event (sem novo lead).
//   D. classify_lead sem lead — retorna {success:false, error:'no_active_lead'}.
//   E. classify_lead com lead — UPDATE + timeline_event. NÃO dispara handoff.
//   F. transfer_to_human dispara handoff via hook (5 efeitos).
//   G. remember_fact insert + supersede (2 chamadas, segunda gera supersede).
//   H. tools_enabled filter — toggle temp tools_enabled=['save_lead_info'],
//      tenta classify_lead → erro 'tool_not_enabled'.
//
// Ground-truth via SQL antes/depois. Cleanup obrigatório no finally.

import 'dotenv/config';
import { sql, inArray, eq } from 'drizzle-orm';

import { db, closeDb } from '../src/db/client';
import {
  contactPhones,
  contacts,
  contactFacts,
  leads,
  messages,
  pipelineColumns,
  tasks,
  timelineEvents,
  traces,
} from '../src/db/schema';
import { run as harnessRun, type MockLLMFn } from '../src/harness/loop';
import type { WebhookPayload } from '../src/edge/payload';
import { getToolByName, getEnabledTools, ALL_TOOLS } from '../src/tools/registry';

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
    'x-message-id': 'smoke-b7-headers',
    'x-instance-id': 'smoke-instance',
    'x-webhook-id': 'smoke-webhook',
    'x-attempt-count': '1',
    'user-agent': 'Zapsterapi/smoke',
  };
}

const SMOKE_PHONES = [
  '5500000020', // B — save_lead_info novo lead
  '5500000021', // C — save_lead_info update
  '5500000022', // D — classify_lead sem lead
  '5500000023', // E — classify_lead com lead
  '5500000024', // F — transfer_to_human handoff
  '5500000025', // G — remember_fact
  '5500000026', // H — tools_enabled filter
];
const SMOKE_ZAPSTER_PREFIX = 'smoke-b7-';

interface Snapshot {
  msgs_b7: number;
  traces_b7: number;
  tasks_hot: number;
  tl_hot: number;
  tl_tool: number;
  facts_smoke: number;
  total_messages: number;
  total_traces: number;
  total_contacts: number;
  total_phones: number;
  total_tasks: number;
  total_tl: number;
  total_leads: number;
  total_facts: number;
  [k: string]: unknown;
}

async function snapshot(label: string): Promise<Snapshot> {
  const r = await db.execute<Snapshot>(sql`
    SELECT
      (SELECT count(*) FROM messages WHERE zapster_message_id LIKE 'smoke-b7-%')::int AS msgs_b7,
      (SELECT count(*) FROM traces WHERE message_id IN (SELECT id FROM messages WHERE zapster_message_id LIKE 'smoke-b7-%'))::int AS traces_b7,
      (SELECT count(*) FROM tasks WHERE title='Lead HOT — atendimento')::int AS tasks_hot,
      (SELECT count(*) FROM timeline_events WHERE title='Handoff HOT')::int AS tl_hot,
      (SELECT count(*) FROM timeline_events WHERE metadata->>'source' LIKE 'tool:%')::int AS tl_tool,
      (SELECT count(*) FROM contact_facts WHERE source='tool:remember_fact')::int AS facts_smoke,
      (SELECT count(*) FROM messages)::int AS total_messages,
      (SELECT count(*) FROM traces)::int AS total_traces,
      (SELECT count(*) FROM contacts)::int AS total_contacts,
      (SELECT count(*) FROM contact_phones)::int AS total_phones,
      (SELECT count(*) FROM tasks)::int AS total_tasks,
      (SELECT count(*) FROM timeline_events)::int AS total_tl,
      (SELECT count(*) FROM leads)::int AS total_leads,
      (SELECT count(*) FROM contact_facts)::int AS total_facts
  `);
  const row = Array.from(r)[0];
  console.log(`\n[${label}]`, JSON.stringify(row));
  return row;
}

async function ensureAngelinaActive(): Promise<{ wasActive: boolean }> {
  // Confere se Angelina v2 está ativa; se não, ativa temporariamente.
  const r = await db.execute<{ is_active: boolean }>(sql`
    SELECT is_active FROM agent_configs WHERE key='angelina' AND version=2
  `);
  const wasActive = Array.from(r)[0]?.is_active === true;
  if (!wasActive) {
    await db.execute(sql`
      UPDATE agent_configs SET is_active=true WHERE key='angelina' AND version=2
    `);
  }
  return { wasActive };
}

async function restoreAngelinaActive(wasActive: boolean): Promise<void> {
  if (!wasActive) {
    await db.execute(sql`
      UPDATE agent_configs SET is_active=false WHERE key='angelina' AND version=2
    `);
  }
}

async function setToolsEnabled(toolsEnabled: string[]): Promise<string[]> {
  const r = await db.execute<{ tools_enabled: string[] }>(sql`
    SELECT tools_enabled FROM agent_configs WHERE key='angelina' AND version=2
  `);
  const prev = Array.from(r)[0]?.tools_enabled ?? [];
  // postgres-js arrays: passar como literal Postgres `{a,b,c}` via JSON.
  // Usar to_jsonb + jsonb_array_elements_text -> array agg para evitar
  // problemas de quoting. Mais simples: converte para text[] via ARRAY().
  // Estrategia escolhida: usar JSON serialize + cast jsonb -> text[].
  await db.execute(sql`
    UPDATE agent_configs
       SET tools_enabled = (
         SELECT array_agg(value::text)
           FROM jsonb_array_elements_text(${JSON.stringify(toolsEnabled)}::jsonb) AS value
       )
     WHERE key='angelina' AND version=2
  `);
  return prev;
}

async function restoreToolsEnabled(prev: string[]): Promise<void> {
  await db.execute(sql`
    UPDATE agent_configs
       SET tools_enabled = (
         SELECT array_agg(value::text)
           FROM jsonb_array_elements_text(${JSON.stringify(prev)}::jsonb) AS value
       )
     WHERE key='angelina' AND version=2
  `);
}

async function getEntryColumnId(): Promise<string> {
  const rows = await db
    .select({ id: pipelineColumns.id })
    .from(pipelineColumns)
    .where(eq(pipelineColumns.type, 'ENTRY'))
    .limit(1);
  if (rows.length === 0) throw new Error('no ENTRY pipeline_column');
  return rows[0].id;
}

async function preCreateContact(phone: string, aiState = 'AUTO'): Promise<string> {
  const [c] = await db
    .insert(contacts)
    .values({
      name: `WhatsApp ${phone}`,
      origin: 'WhatsApp',
      aiState,
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

async function preCreateLead(
  contactId: string,
  opts: {
    eventType?: 'WEDDING' | 'BIRTHDAY' | 'CORPORATE' | 'GRADUATION' | 'SWEET_FIFTEEN' | 'OTHER';
    eventDate?: string;
    guestCount?: number;
    classification?: 'HOT' | 'WARM' | 'COLD';
  } = {},
): Promise<string> {
  const entryId = await getEntryColumnId();
  const [l] = await db
    .insert(leads)
    .values({
      contactId,
      pipelineColumnId: entryId,
      classification: opts.classification ?? 'COLD',
      eventType: opts.eventType,
      eventDate: opts.eventDate,
      guestCount: opts.guestCount,
      origin: 'WHATSAPP',
    })
    .returning({ id: leads.id });
  return l.id;
}

async function cleanup(): Promise<void> {
  console.log('\n[CLEANUP] starting');

  const smokeContactRows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(contactPhones, eq(contactPhones.contactId, contacts.id))
    .where(inArray(contactPhones.phone, SMOKE_PHONES));
  const contactIds = smokeContactRows.map((r) => r.id);
  console.log('[CLEANUP] smoke contact ids', contactIds);

  if (contactIds.length > 0) {
    // contact_facts
    const delFacts = await db
      .delete(contactFacts)
      .where(inArray(contactFacts.contactId, contactIds))
      .returning({ id: contactFacts.id });
    console.log('[CLEANUP] contact_facts deleted', delFacts.length);

    // timeline_events
    const delTl = await db
      .delete(timelineEvents)
      .where(inArray(timelineEvents.contactId, contactIds))
      .returning({ id: timelineEvents.id });
    console.log('[CLEANUP] timeline_events deleted', delTl.length);

    // tasks
    const delTasks = await db
      .delete(tasks)
      .where(inArray(tasks.contactId, contactIds))
      .returning({ id: tasks.id });
    console.log('[CLEANUP] tasks deleted', delTasks.length);

    // traces
    const delTraces = await db
      .delete(traces)
      .where(inArray(traces.contactId, contactIds))
      .returning({ id: traces.id });
    console.log('[CLEANUP] traces deleted', delTraces.length);

    // messages
    const delMsgs = await db
      .delete(messages)
      .where(inArray(messages.contactId, contactIds))
      .returning({ id: messages.id });
    console.log('[CLEANUP] messages deleted', delMsgs.length);

    // leads
    const delLeads = await db
      .delete(leads)
      .where(inArray(leads.contactId, contactIds))
      .returning({ id: leads.id });
    console.log('[CLEANUP] leads deleted', delLeads.length);

    // contact_phones
    const delPhones = await db
      .delete(contactPhones)
      .where(inArray(contactPhones.contactId, contactIds))
      .returning({ id: contactPhones.id });
    console.log('[CLEANUP] contact_phones deleted', delPhones.length);

    // contacts
    const delContacts = await db
      .delete(contacts)
      .where(inArray(contacts.id, contactIds))
      .returning({ id: contacts.id });
    console.log('[CLEANUP] contacts deleted', delContacts.length);
  }

  // Defesa em profundidade — orphans por zapster_message_id smoke-b7-*
  const orphanMsgs = await db
    .delete(messages)
    .where(sql`zapster_message_id LIKE ${SMOKE_ZAPSTER_PREFIX + '%'}`)
    .returning({ id: messages.id });
  if (orphanMsgs.length > 0) {
    console.log('[CLEANUP] orphan messages by zapster_id deleted', orphanMsgs.length);
  }

  // Mock outbounds das ultimas 15min (Bloco 6 deixa mock-* via mockSendOutbound)
  const orphanMock = await db
    .delete(messages)
    .where(sql`zapster_message_id LIKE 'mock-%' AND direction='OUTBOUND'
               AND created_at > now() - interval '15 minutes'`)
    .returning({ id: messages.id });
  if (orphanMock.length > 0) {
    console.log('[CLEANUP] orphan mock outbounds deleted', orphanMock.length);
  }

  console.log('[CLEANUP] done');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers para mock LLM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cria um MockLLMFn que na iteração 0 retorna `toolCalls`, na iteração 1
 * retorna texto final fixo (sem mais tools). Útil para smokes que querem
 * disparar 1 tool e sair com texto.
 */
function mockSingleToolThenText(
  toolName: string,
  input: unknown,
  finalText = 'mock final text',
): MockLLMFn {
  return async (_ctx, iter) => {
    if (iter === 0) {
      return { text: '', toolCalls: [{ name: toolName, input }] };
    }
    return { text: finalText, toolCalls: [] };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cenários
// ─────────────────────────────────────────────────────────────────────────────

interface CaseResult {
  name: string;
  pass: boolean;
  details: Record<string, unknown>;
}

async function smokeA(): Promise<CaseResult> {
  console.log('\n=== Smoke A — Registry ===');
  const t1 = getToolByName('save_lead_info');
  const t2 = getToolByName('foo');
  const subset = getEnabledTools(['save_lead_info', 'classify_lead']);
  const subsetTypo = getEnabledTools(['typo_tool']);

  const pass =
    t1 !== undefined &&
    t1.name === 'save_lead_info' &&
    t2 === undefined &&
    subset.length === 2 &&
    subset.map((t) => t.name).sort().join(',') === 'classify_lead,save_lead_info' &&
    subsetTypo.length === 0 &&
    ALL_TOOLS.length === 4;

  return {
    name: 'A — registry',
    pass,
    details: {
      t1Found: t1?.name,
      t2Found: t2,
      subsetNames: subset.map((t) => t.name),
      subsetTypoLen: subsetTypo.length,
      allToolsLen: ALL_TOOLS.length,
    },
  };
}

async function smokeB(): Promise<CaseResult> {
  const phone = '5500000020';
  const zapMsgId = 'smoke-b7-msg-001';
  console.log(`\n=== Smoke B — save_lead_info novo lead (${phone}) ===`);

  // Pré-cria SOMENTE contact (sem lead).
  const contactId = await preCreateContact(phone);

  const llmFn = mockSingleToolThenText(
    'save_lead_info',
    { event_type: 'WEDDING', event_date: '2026-12-15', guest_count: 200 },
    'Que ótimo! Vou anotar.',
  );

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, 'casamento dia 15/12/2026, 200 convidados'),
    buildHeaders(),
    { mockLLM: llmFn },
  );
  console.log('  result:', result);

  const leadsQ = await db.execute<{ count: number; lead_id: string | null; pipeline_column_id: string | null }>(sql`
    SELECT count(*)::int AS count,
           max(id::text) AS lead_id,
           max(pipeline_column_id::text) AS pipeline_column_id
      FROM leads WHERE contact_id = ${contactId}
  `);
  const leadRow = Array.from(leadsQ)[0];

  const tlQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM timeline_events
     WHERE contact_id = ${contactId}
       AND metadata->>'source' = 'tool:save_lead_info'
  `);
  const tlCount = Array.from(tlQ)[0].count;

  const entryId = await getEntryColumnId();

  const pass =
    result.status === 'completed' &&
    leadRow.count === 1 &&
    leadRow.pipeline_column_id === entryId &&
    tlCount === 1;

  return {
    name: 'B — save_lead_info novo lead',
    pass,
    details: {
      status: result.status,
      leadsCount: leadRow.count,
      leadId: leadRow.lead_id,
      entryId,
      pipelineColumnIdMatch: leadRow.pipeline_column_id === entryId,
      tlCount,
    },
  };
}

async function smokeC(): Promise<CaseResult> {
  const phone = '5500000021';
  const zapMsgId = 'smoke-b7-msg-002';
  console.log(`\n=== Smoke C — save_lead_info update (${phone}) ===`);

  const contactId = await preCreateContact(phone);
  const leadId = await preCreateLead(contactId, {
    eventType: 'WEDDING',
    eventDate: '2026-12-15',
    guestCount: 100,
  });

  const llmFn = mockSingleToolThenText(
    'save_lead_info',
    { notes: 'gosta de chocolate' },
    'Anotado!',
  );

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, 'gosto de chocolate'),
    buildHeaders(),
    { mockLLM: llmFn },
  );
  console.log('  result:', result);

  const leadsQ = await db.execute<{ count: number; notes: string | null }>(sql`
    SELECT count(*)::int AS count, max(notes) AS notes FROM leads
     WHERE contact_id = ${contactId}
  `);
  const leadRow = Array.from(leadsQ)[0];

  const tlQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM timeline_events
     WHERE lead_id = ${leadId}
       AND metadata->>'source' = 'tool:save_lead_info'
  `);
  const tlCount = Array.from(tlQ)[0].count;

  const pass =
    result.status === 'completed' &&
    leadRow.count === 1 &&
    leadRow.notes === 'gosta de chocolate' &&
    tlCount === 1;

  return {
    name: 'C — save_lead_info update',
    pass,
    details: {
      status: result.status,
      leadsCount: leadRow.count,
      notes: leadRow.notes,
      tlCount,
    },
  };
}

async function smokeD(): Promise<CaseResult> {
  const phone = '5500000022';
  const zapMsgId = 'smoke-b7-msg-003';
  console.log(`\n=== Smoke D — classify_lead sem lead (${phone}) ===`);

  const contactId = await preCreateContact(phone);

  const llmFn = mockSingleToolThenText(
    'classify_lead',
    { classification: 'HOT' },
    'Vou continuar conversando.',
  );

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, 'pode me passar valores?'),
    buildHeaders(),
    { mockLLM: llmFn },
  );
  console.log('  result:', result);

  // Lead NÃO deve ter sido criado.
  const leadsQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM leads WHERE contact_id = ${contactId}
  `);
  const leadCount = Array.from(leadsQ)[0].count;

  // O tool_result persistido em messages deve mostrar o erro.
  const toolMsgQ = await db.execute<{ count: number; tool_result: unknown }>(sql`
    SELECT count(*)::int AS count, max(tool_result::text) AS tool_result FROM messages
     WHERE contact_id = ${contactId}
       AND tool_name = 'classify_lead'
       AND role = 'tool'
  `);
  const toolMsgRow = Array.from(toolMsgQ)[0];
  const toolResultStr = String(toolMsgRow.tool_result ?? '');

  const pass =
    result.status === 'completed' &&
    leadCount === 0 &&
    toolMsgRow.count === 1 &&
    toolResultStr.includes('no_active_lead');

  return {
    name: 'D — classify_lead sem lead',
    pass,
    details: {
      status: result.status,
      leadCount,
      toolMsgCount: toolMsgRow.count,
      toolResultPreview: toolResultStr.slice(0, 200),
    },
  };
}

async function smokeE(): Promise<CaseResult> {
  const phone = '5500000023';
  const zapMsgId = 'smoke-b7-msg-004';
  console.log(`\n=== Smoke E — classify_lead com lead (${phone}) ===`);

  const contactId = await preCreateContact(phone);
  const leadId = await preCreateLead(contactId);

  const llmFn = mockSingleToolThenText(
    'classify_lead',
    { classification: 'WARM', reason: 'budget incerto' },
    'Anotado!',
  );

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, 'ainda nao defini orcamento'),
    buildHeaders(),
    { mockLLM: llmFn },
  );
  console.log('  result:', result);

  const leadQ = await db.execute<{ classification: string }>(sql`
    SELECT classification::text AS classification FROM leads WHERE id = ${leadId}
  `);
  const cls = Array.from(leadQ)[0]?.classification;

  const tlQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM timeline_events
     WHERE lead_id = ${leadId}
       AND metadata->>'source' = 'tool:classify_lead'
  `);
  const tlCount = Array.from(tlQ)[0].count;

  // Lead is_human_active deve continuar false (classify NÃO dispara handoff).
  const humanQ = await db.execute<{ is_human_active: boolean }>(sql`
    SELECT is_human_active FROM leads WHERE id = ${leadId}
  `);
  const isHumanActive = Array.from(humanQ)[0]?.is_human_active;

  // Tasks 'Lead HOT' NÃO criada (transfer-trigger não rodou).
  const taskQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM tasks
     WHERE lead_id = ${leadId} AND title='Lead HOT — atendimento'
  `);
  const taskCount = Array.from(taskQ)[0].count;

  const pass =
    result.status === 'completed' &&
    cls === 'WARM' &&
    tlCount === 1 &&
    isHumanActive === false &&
    taskCount === 0;

  return {
    name: 'E — classify_lead com lead',
    pass,
    details: {
      status: result.status,
      classification: cls,
      tlCount,
      isHumanActive,
      taskCount,
    },
  };
}

async function smokeF(): Promise<CaseResult> {
  const phone = '5500000024';
  const zapMsgId = 'smoke-b7-msg-005';
  console.log(`\n=== Smoke F — transfer_to_human handoff (${phone}) ===`);

  const contactId = await preCreateContact(phone);
  const leadId = await preCreateLead(contactId, {
    eventType: 'WEDDING',
    eventDate: '2026-12-15',
    guestCount: 200,
  });

  const llmFn = mockSingleToolThenText(
    'transfer_to_human',
    { reason: 'pediu humano' },
    'Vou transferir.',
  );

  const result = await harnessRun(
    buildPayload(phone, zapMsgId, 'quero falar com pessoa'),
    buildHeaders(),
    { mockLLM: llmFn },
  );
  console.log('  result:', result);

  // 1. is_human_active=true
  const leadQ = await db.execute<{ is_human_active: boolean }>(sql`
    SELECT is_human_active FROM leads WHERE id = ${leadId}
  `);
  const isHumanActive = Array.from(leadQ)[0]?.is_human_active;

  // 2. tasks
  const taskQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM tasks
     WHERE lead_id = ${leadId} AND title='Lead HOT — atendimento'
  `);
  const taskCount = Array.from(taskQ)[0].count;

  // 3. timeline_events 'Handoff HOT'
  const tlHotQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM timeline_events
     WHERE lead_id = ${leadId} AND title='Handoff HOT'
  `);
  const tlHotCount = Array.from(tlHotQ)[0].count;

  // 4. trace handoff_complete
  const tracesQ = await db.execute<{ types: string[] }>(sql`
    SELECT array_agg(distinct event_type) AS types FROM traces
     WHERE contact_id = ${contactId}
  `);
  const types = Array.from(tracesQ)[0].types ?? [];

  // 5. trace handoff_requested (emitido pela tool transfer_to_human)
  const handoffRequested = types.includes('handoff_requested');
  const handoffComplete = types.includes('handoff_complete');
  const supportUnset = types.includes('support_whatsapp_unset');

  // format-whatsapp NÃO rodou (transfer cortou)
  const formatHookRan = types.includes('hook_format-whatsapp');

  // outbound NÃO criado (transfer cortou antes do INSERT)
  const outboundQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE contact_id = ${contactId} AND direction='OUTBOUND' AND role='assistant'
  `);
  const outboundCount = Array.from(outboundQ)[0].count;

  // tool_call persistido (role='tool')
  const toolMsgQ = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messages
     WHERE contact_id = ${contactId} AND role='tool' AND tool_name='transfer_to_human'
  `);
  const toolMsgCount = Array.from(toolMsgQ)[0].count;

  const pass =
    result.status === 'short_circuit' &&
    isHumanActive === true &&
    taskCount === 1 &&
    tlHotCount === 1 &&
    handoffRequested === true &&
    handoffComplete === true &&
    supportUnset === true && // support_whatsapp='' -> skipa send_4
    formatHookRan === false && // transfer cortou
    outboundCount === 0 && // transfer cortou
    toolMsgCount === 1; // tool_call persistido

  return {
    name: 'F — transfer_to_human handoff',
    pass,
    details: {
      status: result.status,
      isHumanActive,
      taskCount,
      tlHotCount,
      handoffRequested,
      handoffComplete,
      supportUnset,
      formatHookRan,
      outboundCount,
      toolMsgCount,
      tracesTypes: types,
    },
  };
}

async function smokeG(): Promise<CaseResult> {
  const phone = '5500000025';
  const zapMsgId1 = 'smoke-b7-msg-006a';
  const zapMsgId2 = 'smoke-b7-msg-006b';
  console.log(`\n=== Smoke G — remember_fact insert + supersede (${phone}) ===`);

  const contactId = await preCreateContact(phone);

  // 1ª chamada
  const llmFn1 = mockSingleToolThenText(
    'remember_fact',
    {
      fact_type: 'preferencia_doce',
      fact_value: { tipo: 'chocolate' },
      confidence: 0.9,
    },
    'Anotado!',
  );
  const r1 = await harnessRun(
    buildPayload(phone, zapMsgId1, 'gosto de chocolate'),
    buildHeaders(),
    { mockLLM: llmFn1 },
  );
  console.log('  r1:', r1);

  // Após 1ª: 1 row em contact_facts (superseded_by=null).
  const factsAfter1 = await db.execute<{
    count: number;
    superseded: number;
    active: number;
  }>(sql`
    SELECT count(*)::int AS count,
           sum(case when superseded_by is not null then 1 else 0 end)::int AS superseded,
           sum(case when superseded_by is null then 1 else 0 end)::int AS active
      FROM contact_facts WHERE contact_id = ${contactId}
  `);
  const af1 = Array.from(factsAfter1)[0];

  // 2ª chamada — mesmo fact_type, novo value
  const llmFn2 = mockSingleToolThenText(
    'remember_fact',
    {
      fact_type: 'preferencia_doce',
      fact_value: { tipo: 'baunilha' },
      confidence: 0.85,
    },
    'Atualizado!',
  );
  const r2 = await harnessRun(
    buildPayload(phone, zapMsgId2, 'na verdade prefiro baunilha'),
    buildHeaders(),
    { mockLLM: llmFn2 },
  );
  console.log('  r2:', r2);

  const factsAfter2 = await db.execute<{
    count: number;
    superseded: number;
    active: number;
  }>(sql`
    SELECT count(*)::int AS count,
           sum(case when superseded_by is not null then 1 else 0 end)::int AS superseded,
           sum(case when superseded_by is null then 1 else 0 end)::int AS active
      FROM contact_facts WHERE contact_id = ${contactId}
  `);
  const af2 = Array.from(factsAfter2)[0];

  // Verifica que a primeira fact tem superseded_by apontando para a segunda
  const detailQ = await db.execute<{
    fact_value: unknown;
    superseded_by: string | null;
  }>(sql`
    SELECT fact_value, superseded_by::text AS superseded_by
      FROM contact_facts WHERE contact_id = ${contactId}
     ORDER BY extracted_at ASC
  `);
  const facts = Array.from(detailQ);

  const pass =
    r1.status === 'completed' &&
    r2.status === 'completed' &&
    af1.count === 1 &&
    af1.active === 1 &&
    af1.superseded === 0 &&
    af2.count === 2 &&
    af2.active === 1 &&
    af2.superseded === 1 &&
    facts.length === 2 &&
    facts[0].superseded_by !== null &&
    facts[1].superseded_by === null;

  return {
    name: 'G — remember_fact append-only',
    pass,
    details: {
      r1Status: r1.status,
      r2Status: r2.status,
      after1: af1,
      after2: af2,
      facts: facts.map((f) => ({
        value: f.fact_value,
        superseded_by: f.superseded_by,
      })),
    },
  };
}

async function smokeH(): Promise<CaseResult> {
  const phone = '5500000026';
  const zapMsgId = 'smoke-b7-msg-007';
  console.log(`\n=== Smoke H — tools_enabled filter (${phone}) ===`);

  const contactId = await preCreateContact(phone);
  const leadId = await preCreateLead(contactId);

  // Toggle tools_enabled para apenas save_lead_info.
  const prevTools = await setToolsEnabled(['save_lead_info']);

  let r;
  try {
    const llmFn = mockSingleToolThenText(
      'classify_lead',
      { classification: 'HOT' },
      'Vou tentar.',
    );
    r = await harnessRun(
      buildPayload(phone, zapMsgId, 'classifique HOT'),
      buildHeaders(),
      { mockLLM: llmFn },
    );
    console.log('  r:', r);
  } finally {
    await restoreToolsEnabled(prevTools);
  }

  // tool_result persistido deve mostrar 'tool_not_enabled'
  const toolMsgQ = await db.execute<{ count: number; tool_result: unknown }>(sql`
    SELECT count(*)::int AS count, max(tool_result::text) AS tool_result FROM messages
     WHERE contact_id = ${contactId} AND tool_name = 'classify_lead'
  `);
  const toolMsgRow = Array.from(toolMsgQ)[0];
  const toolResultStr = String(toolMsgRow.tool_result ?? '');

  // Lead NÃO deve ter classification atualizada (continua COLD default).
  const leadQ = await db.execute<{ classification: string }>(sql`
    SELECT classification::text AS classification FROM leads WHERE id = ${leadId}
  `);
  const cls = Array.from(leadQ)[0]?.classification;

  const pass =
    r.status === 'completed' &&
    toolMsgRow.count === 1 &&
    toolResultStr.includes('tool_not_enabled') &&
    cls === 'COLD';

  return {
    name: 'H — tools_enabled filter',
    pass,
    details: {
      status: r.status,
      toolResultPreview: toolResultStr.slice(0, 200),
      classification: cls,
      toolMsgCount: toolMsgRow.count,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const before = await snapshot('BEFORE');
  const angState = await ensureAngelinaActive();
  console.log('[main] angelina was active?', angState.wasActive);

  const results: CaseResult[] = [];
  let mid: Snapshot | undefined;

  try {
    results.push(await smokeA());
    results.push(await smokeB());
    results.push(await smokeC());
    results.push(await smokeD());
    results.push(await smokeE());
    results.push(await smokeF());
    results.push(await smokeG());
    results.push(await smokeH());

    mid = await snapshot('MID');
  } finally {
    await restoreAngelinaActive(angState.wasActive);
    await cleanup();
  }

  const after = await snapshot('AFTER');

  console.log('\n========== SMOKE RESULTS ==========');
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} — ${r.name}`);
    if (!r.pass) {
      console.log('    details:', JSON.stringify(r.details, null, 2));
    }
  }

  const allPass = results.every((r) => r.pass);
  console.log(`\nAll pass: ${allPass}`);

  console.log('\n========== SNAPSHOTS ==========');
  console.log('BEFORE:', JSON.stringify(before));
  console.log('MID   :', JSON.stringify(mid ?? '(skipped)'));
  console.log('AFTER :', JSON.stringify(after));

  // Confere AFTER == BEFORE.
  const keysToCheck: (keyof Snapshot)[] = [
    'msgs_b7',
    'traces_b7',
    'tasks_hot',
    'tl_tool',
    'facts_smoke',
    'total_messages',
    'total_traces',
    'total_contacts',
    'total_phones',
    'total_tasks',
    'total_tl',
    'total_leads',
    'total_facts',
  ];
  const diffs: string[] = [];
  for (const k of keysToCheck) {
    if (before[k] !== after[k]) {
      diffs.push(`${k}: BEFORE=${before[k]} AFTER=${after[k]}`);
    }
  }
  if (diffs.length > 0) {
    console.log('\n[CLEANUP CHECK] FAIL — drift detected:', diffs);
  } else {
    console.log('\n[CLEANUP CHECK] PASS — AFTER === BEFORE');
  }

  await closeDb();

  process.exit(allPass && diffs.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[main] fatal:', err);
  try {
    await cleanup();
  } catch {
    // silent
  }
  await closeDb();
  process.exit(2);
});
