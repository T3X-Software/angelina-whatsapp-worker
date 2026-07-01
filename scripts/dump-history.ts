// Script READ-ONLY: puxa histórico de conversa por número de telefone.
// Uso: npx tsx scripts/dump-history.ts 5519997124472
import { db, closeDb } from '../src/db/client';
import { contacts, contactPhones, messages } from '../src/db/schema';
import { eq, asc, inArray } from 'drizzle-orm';

async function main() {
  const phone = process.argv[2];
  if (!phone) throw new Error('informe o telefone como argumento');

  // normaliza: só dígitos
  const digits = phone.replace(/\D/g, '');

  const phoneRows = await db
    .select({ contactId: contactPhones.contactId, phone: contactPhones.phone })
    .from(contactPhones);

  const matched = phoneRows.filter((r) => r.phone.replace(/\D/g, '') === digits);
  if (matched.length === 0) {
    console.log(`Nenhum contato encontrado com telefone ${digits}`);
    console.log('Amostra de telefones no banco:', phoneRows.slice(0, 10).map((r) => r.phone));
    return;
  }

  const contactIds = [...new Set(matched.map((r) => r.contactId))];
  const contactRows = await db
    .select()
    .from(contacts)
    .where(inArray(contacts.id, contactIds));

  for (const c of contactRows) {
    console.log('====================================================');
    console.log(`CONTATO: ${c.name} | id=${c.id} | ai_state=${c.aiState} | origin=${c.origin}`);
    console.log('====================================================');

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.contactId, c.id))
      .orderBy(asc(messages.createdAt));

    console.log(`Total de rows em messages: ${msgs.length}\n`);

    for (const m of msgs) {
      const ts = m.createdAt ? new Date(m.createdAt).toISOString().replace('T', ' ').slice(0, 19) : '?';
      const dir = m.direction;
      const role = m.role;
      let body = m.text ?? '';
      if (m.transcription) body += ` [transcrição: ${m.transcription}]`;
      if (m.mediaUrl) body += ` [mídia ${m.mediaType ?? ''}: ${m.mediaUrl}]`;
      if (m.toolName) body += ` [tool ${m.toolName} args=${JSON.stringify(m.toolArgs)} result=${JSON.stringify(m.toolResult)}]`;
      console.log(`[${ts}] (${dir}/${role}) ${body}`);
    }
    console.log('');
  }
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error('ERRO:', e);
    await closeDb();
    process.exit(1);
  });
