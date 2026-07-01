// READ-ONLY: inspeciona leads e distribuição de mensagens de um contato.
// Uso: npx tsx scripts/inspect-leads.ts 5519997124472
import { db, closeDb } from '../src/db/client';
import { contacts, contactPhones, messages, leads, tasks, timelineEvents, followUpAttempts, contactFacts } from '../src/db/schema';
import { eq, asc, sql } from 'drizzle-orm';

async function main() {
  const digits = (process.argv[2] ?? '').replace(/\D/g, '');
  const phoneRows = await db.select().from(contactPhones);
  const match = phoneRows.find((r) => r.phone.replace(/\D/g, '') === digits);
  if (!match) { console.log('contato não encontrado'); return; }
  const contactId = match.contactId;
  console.log('contactId =', contactId, '\n');

  const leadRows = await db.select().from(leads).where(eq(leads.contactId, contactId)).orderBy(asc(leads.createdAt));
  console.log('== LEADS ==');
  for (const l of leadRows) {
    const cnt = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(eq(messages.leadId, l.id));
    console.log(`lead ${l.id} | criado ${l.createdAt?.toISOString?.() ?? l.createdAt} | tipo=${l.eventType} data=${l.eventDate} conv=${l.guestCount} class=${l.classification} status=${l.status} human=${l.isHumanActive} | msgs c/ esse lead_id=${cnt[0].n}`);
  }

  const totalMsgs = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(eq(messages.contactId, contactId));
  const nullLead = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(sql`${messages.contactId} = ${contactId} AND ${messages.leadId} IS NULL`);
  console.log(`\nmensagens totais do contato = ${totalMsgs[0].n} | com lead_id NULL = ${nullLead[0].n}`);

  console.log('\n== rows dependentes ==');
  const t = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.contactId, contactId));
  const te = await db.select({ n: sql<number>`count(*)::int` }).from(timelineEvents).where(eq(timelineEvents.contactId, contactId));
  const cf = await db.select({ n: sql<number>`count(*)::int` }).from(contactFacts).where(eq(contactFacts.contactId, contactId));
  console.log(`tasks(contato)=${t[0].n} timeline_events(contato)=${te[0].n} contact_facts(contato)=${cf[0].n}`);
  for (const l of leadRows) {
    const fu = await db.select({ n: sql<number>`count(*)::int` }).from(followUpAttempts).where(eq(followUpAttempts.leadId, l.id));
    const tl = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.leadId, l.id));
    console.log(`lead ${l.id}: follow_up_attempts=${fu[0].n} tasks(lead)=${tl[0].n}`);
  }
}

main().then(() => closeDb()).catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
