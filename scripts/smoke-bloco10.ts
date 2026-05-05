// scripts/smoke-bloco10.ts
//
// Bloco 10 — Smoke programático MÍNIMO (modo econômico, 1 cenário).
//
//   Smoke 1 — composer com 5 msgs + 4 facts (1 abaixo do threshold).
//     1. Cria contact 5500000100 + 1 lead.
//     2. INSERT 5 msgs alternadas (3 user + 2 assistant) com timestamps escalonados.
//     3. INSERT 4 contact_facts:
//          - 3 com confidence=0.9 (estagio, preferencia, restricao)  [esperados em L2]
//          - 1 com confidence=0.5 (objecao "ainda em discussão")     [excluído]
//     4. Constrói HarnessContext mock minimal com config inline (agent_configs
//        v2 está com is_active=false; passamos um row sintético ao composer).
//     5. Chama compose(ctx).
//     6. Asserts:
//          - messages.length === 6 (5 prévias + 1 atual user turn)
//          - system contém "## Sumário do contato"
//          - system contém os 3 facts >= 0.7 e NÃO contém o fact 0.5
//          - tokenEstimate > 0
//          - l2 não vazio; l1Count === 5; systemChars > base
//
// Cleanup obrigatório no finally — DELETE traces/contact_facts/messages/leads
// /contact_phones/contacts dos phones smoke (cuida das FKs).
//
// SQL antes/depois (modo econômico): 1 SELECT count agregado, esperar 0 depois.

import 'dotenv/config';
import { sql, inArray } from 'drizzle-orm';

import { db, closeDb } from '../src/db/client';
import {
  contactPhones,
  contacts,
  contactFacts,
  messages,
  leads,
  traces,
} from '../src/db/schema';
import { compose } from '../src/memory/composer';
import type { HarnessContext, AgentConfigRow } from '../src/harness/types';
import type { EventBus } from '../src/harness/types';
import type { WebhookPayload } from '../src/edge/payload';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SMOKE_PHONE = '5500000100';

interface AggSnapshot {
  facts_b10: number;
  msgs_b10: number;
  total_facts: number;
  total_messages: number;
}

async function snapshot(label: string): Promise<AggSnapshot> {
  const r = await db.execute<AggSnapshot & Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM contact_facts
        WHERE contact_id IN (
          SELECT contact_id FROM contact_phones WHERE phone = ${SMOKE_PHONE}
        )
      )::int AS facts_b10,
      (SELECT count(*) FROM messages
        WHERE contact_id IN (
          SELECT contact_id FROM contact_phones WHERE phone = ${SMOKE_PHONE}
        )
      )::int AS msgs_b10,
      (SELECT count(*) FROM contact_facts)::int AS total_facts,
      (SELECT count(*) FROM messages)::int     AS total_messages
  `);
  const row = Array.from(r)[0] as AggSnapshot;
  console.log(`\n[${label}]`, JSON.stringify(row));
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

async function ensureContact(): Promise<{ contactId: string; leadId: string | null }> {
  // Cria contact + phone. Lead é OPCIONAL para o composer (ele só usa
  // contactId). Pulamos a criação de lead — evita lookup de pipeline_column
  // que adicionaria complexidade ao smoke sem ganho.
  const c = await db
    .insert(contacts)
    .values({ name: `B10 ${SMOKE_PHONE}`, origin: 'WhatsApp' })
    .returning({ id: contacts.id });
  const contactId = c[0].id;

  await db.insert(contactPhones).values({
    contactId,
    phone: SMOKE_PHONE,
    type: 'mobile',
    isPrimary: true,
    isWhatsapp: true,
  });

  return { contactId, leadId: null };
}

async function insertConversation(contactId: string, leadId: string | null): Promise<void> {
  // 5 mensagens alternadas (user, assistant, user, assistant, user) com texto.
  // Timestamps escalonados (now() - i*60s reverso para ordem cronológica).
  const base = new Date();
  const m: Array<{ role: 'user' | 'assistant'; text: string; offsetSec: number }> = [
    { role: 'user',      text: 'Oi, queria saber sobre o espaço',           offsetSec: -300 },
    { role: 'assistant', text: 'Olá! Que tipo de evento você está pensando?', offsetSec: -240 },
    { role: 'user',      text: 'Casamento em dezembro/2026, ~200 convidados', offsetSec: -180 },
    { role: 'assistant', text: 'Maravilha! Posso te contar como funciona a visita?', offsetSec: -120 },
    { role: 'user',      text: 'Sim, quero saber',                            offsetSec: -60  },
  ];

  for (const msg of m) {
    const createdAt = new Date(base.getTime() + msg.offsetSec * 1000);
    const isOutbound = msg.role === 'assistant';
    // CHECK_1 (messages_direction_send_consistency_chk): OUTBOUND exige
    // send_status NOT NULL. Setamos 'sent' + send_attempted_at + zapster_id
    // numa só INSERT (CHECK_3 também respeitado).
    if (isOutbound) {
      const zid = 'smoke-b10-' + Math.random().toString(36).slice(2, 10);
      await db.execute(sql`
        INSERT INTO messages (
          contact_id, lead_id, direction, role, text, created_at,
          send_status, send_attempted_at, zapster_message_id
        ) VALUES (
          ${contactId},
          ${leadId},
          'OUTBOUND'::message_direction,
          'assistant'::message_role,
          ${msg.text},
          ${createdAt.toISOString()}::timestamptz,
          'sent'::message_send_status,
          ${createdAt.toISOString()}::timestamptz,
          ${zid}
        )
      `);
    } else {
      await db.execute(sql`
        INSERT INTO messages (
          contact_id, lead_id, direction, role, text, created_at
        ) VALUES (
          ${contactId},
          ${leadId},
          'INBOUND'::message_direction,
          'user'::message_role,
          ${msg.text},
          ${createdAt.toISOString()}::timestamptz
        )
      `);
    }
  }
}

async function insertFacts(contactId: string): Promise<void> {
  // 3 facts >= 0.7 + 1 fact 0.5 (excluído).
  const factsToInsert = [
    { fact_type: 'estagio',     fact_value: { value: 'qualificacao' },                 confidence: 0.95 },
    { fact_type: 'preferencia', fact_value: { estilo: 'classico', cores: 'pasteis' }, confidence: 0.85 },
    { fact_type: 'restricao',   fact_value: { value: 'orcamento limitado' },          confidence: 0.75 },
    // Abaixo do threshold — não deve aparecer.
    { fact_type: 'objecao',     fact_value: { value: 'ainda em discussao com noivo' },confidence: 0.50 },
  ];

  for (const f of factsToInsert) {
    await db.insert(contactFacts).values({
      contactId,
      factType: f.fact_type,
      factValue: f.fact_value,
      confidence: String(f.confidence),
      source: 'smoke-b10',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HarnessContext mock minimal
// ─────────────────────────────────────────────────────────────────────────────

function makeMockEventBus(): EventBus {
  const events: unknown[] = [];
  return {
    emit: (eventType, payload) => { events.push({ eventType, payload }); },
    emitHook: () => {},
    emitTool: () => {},
    bindMessageId: () => {},
    flushToDatabase: async () => ({ inserted: 0 }),
    events: [] as never,
  };
}

function makeMockConfig(): AgentConfigRow {
  // Reaproveita campos default do schema; system_prompt fixo curto para
  // facilitar verificação ("BASE_PROMPT_X" deve estar no system).
  return {
    id: '00000000-0000-0000-0000-000000000000',
    key: 'angelina',
    version: 99,
    systemPrompt: 'BASE_PROMPT_SMOKE_B10',
    model: 'claude-sonnet-4-6',
    temperature: '0.4',
    maxIterations: 5,
    toolsEnabled: ['save_lead_info', 'remember_fact'],
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4o',
    fallbackMessage: 'fallback test',
    supportWhatsapp: '',
    hookParams: {},
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AgentConfigRow;
}

function makeCtx(contactId: string, leadId: string | null): HarnessContext {
  const payload: WebhookPayload = {
    data: {
      sender: { id: SMOKE_PHONE },
      recipient: { id: 'wa-instance', type: 'chat' },
      message: {
        id: 'smoke-b10-incoming',
        type: 'text',
        text: 'Quanto custa o espaço para 200 pessoas?',
      },
    },
  } as unknown as WebhookPayload;

  return {
    turn: { id: 'mock-turn', startedAt: Date.now() },
    contact: { id: contactId, phone: SMOKE_PHONE, aiState: 'AUTO' },
    lead: leadId ? { id: leadId, isHumanActive: false, classification: null } : null,
    message: {
      inboundId: 'mock-inbound',
      zapsterMessageId: 'smoke-b10-incoming',
      text: 'Quanto custa o espaço para 200 pessoas?',
      type: 'text',
    },
    config: makeMockConfig(),
    payload,
    headers: {},
    eventBus: makeMockEventBus(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  console.log('\n[CLEANUP] starting');
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(contactPhones, sql`${contactPhones.contactId} = ${contacts.id}`)
    .where(sql`${contactPhones.phone} = ${SMOKE_PHONE}`);
  const contactIds = rows.map((r) => r.id);
  if (contactIds.length === 0) { console.log('[CLEANUP] nothing'); return; }

  // traces -> facts -> messages -> leads -> contact_phones -> contacts
  const msgRows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.contactId, contactIds));
  const msgIds = msgRows.map((r) => r.id);
  if (msgIds.length > 0) {
    await db.delete(traces).where(inArray(traces.messageId, msgIds));
  }
  await db.delete(traces).where(inArray(traces.contactId, contactIds));
  await db.delete(contactFacts).where(inArray(contactFacts.contactId, contactIds));
  await db.delete(messages).where(inArray(messages.contactId, contactIds));
  // Lead pode existir se contact reusado em testes anteriores; deleta defensive.
  await db.delete(leads).where(inArray(leads.contactId, contactIds));
  await db.delete(contactPhones).where(inArray(contactPhones.contactId, contactIds));
  await db.delete(contacts).where(inArray(contacts.id, contactIds));
  console.log('[CLEANUP] done — contacts:', contactIds.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke 1
// ─────────────────────────────────────────────────────────────────────────────

async function smoke1(): Promise<{ pass: boolean; details: string }> {
  console.log('\n=== Smoke 1: composer com 5 msgs + 4 facts (1 abaixo do threshold) ===');

  const { contactId, leadId } = await ensureContact();
  console.log('  contactId:', contactId, 'leadId:', leadId);

  await insertConversation(contactId, leadId);
  await insertFacts(contactId);

  const ctx = makeCtx(contactId, leadId);
  const composed = await compose(ctx);

  console.log('  composed.l1Count:', composed.l1Count);
  console.log('  composed.l2Chars:', composed.l2Chars);
  console.log('  composed.systemChars:', composed.systemChars);
  console.log('  composed.tokenEstimate:', composed.tokenEstimate);
  console.log('  composed.messages.length:', composed.messages.length);
  console.log('  composed.l2:\n----\n' + composed.l2 + '\n----');
  console.log('  composed.system (preview):\n----\n' + composed.system.slice(0, 600) + '\n----');

  // Asserts
  if (composed.messages.length !== 6) {
    return { pass: false, details: `messages.length expected 6, got ${composed.messages.length}` };
  }
  if (composed.l1Count !== 5) {
    return { pass: false, details: `l1Count expected 5, got ${composed.l1Count}` };
  }
  if (!composed.system.includes('## Sumário do contato')) {
    return { pass: false, details: 'system missing "## Sumário do contato"' };
  }
  if (!composed.system.includes('## Contexto temporal')) {
    return { pass: false, details: 'system missing "## Contexto temporal"' };
  }
  if (!composed.system.includes('BASE_PROMPT_SMOKE_B10')) {
    return { pass: false, details: 'system missing base prompt' };
  }
  // Facts esperados (3 com >=0.7).
  const expectedTokens = ['qualificacao', 'classico', 'orcamento limitado'];
  for (const tok of expectedTokens) {
    if (!composed.system.includes(tok)) {
      return { pass: false, details: `system missing expected fact token: "${tok}"` };
    }
  }
  // Fact com confidence 0.5 NÃO deve aparecer.
  if (composed.system.includes('ainda em discussao')) {
    return { pass: false, details: 'system contém fact com confidence 0.5 (não deveria)' };
  }
  if (composed.tokenEstimate <= 0) {
    return { pass: false, details: `tokenEstimate not positive: ${composed.tokenEstimate}` };
  }
  // Verifica labels PT-BR
  if (!composed.system.includes('Estágio:')) {
    return { pass: false, details: 'system missing "Estágio:" label' };
  }
  if (!composed.system.includes('Preferências:')) {
    return { pass: false, details: 'system missing "Preferências:" label' };
  }
  if (!composed.system.includes('Restrições:')) {
    return { pass: false, details: 'system missing "Restrições:" label' };
  }
  // Última message deve ser o user turn atual.
  const last = composed.messages[composed.messages.length - 1];
  if (last.role !== 'user' || typeof last.content !== 'string' ||
      !last.content.includes('Quanto custa')) {
    return { pass: false, details: 'last message is not the current user turn' };
  }

  return { pass: true, details: 'all asserts passed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const before = await snapshot('SNAPSHOT BEFORE');
  let smokeResult: { pass: boolean; details: string } | null = null;

  try {
    smokeResult = await smoke1();
    console.log('\nSmoke 1:', smokeResult.pass ? 'PASS' : 'FAIL', '—', smokeResult.details);
  } catch (err) {
    console.error('\nSmoke 1: THREW —', err instanceof Error ? err.message : String(err));
    smokeResult = {
      pass: false,
      details: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await cleanup();
    const after = await snapshot('SNAPSHOT AFTER');
    const cleanupOk =
      after.facts_b10 === 0 &&
      after.msgs_b10 === 0 &&
      after.total_facts === before.total_facts &&
      after.total_messages === before.total_messages;
    console.log('\nCleanup check:', cleanupOk ? 'PASS' : 'FAIL');
    if (!cleanupOk) {
      console.error('  before:', JSON.stringify(before));
      console.error('  after :', JSON.stringify(after));
    }
    await closeDb();
    process.exit(smokeResult?.pass && cleanupOk ? 0 : 1);
  }
}

main().catch(async (err) => {
  console.error('FATAL', err);
  try { await closeDb(); } catch { /* ignore */ }
  process.exit(1);
});
