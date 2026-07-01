// READ-ONLY: metadados completos das mensagens de um contato (por telefone).
// Útil para debug de origem (chat vs group), status de envio, tool rows.
// Uso: npx tsx scripts/inspect-msg-meta.ts 5519997124472
import { db, closeDb } from '../src/db/client';
import { messages, contactPhones } from '../src/db/schema';
import { eq, asc } from 'drizzle-orm';

async function main() {
  const digits = (process.argv[2] ?? '').replace(/\D/g, '');
  if (!digits) throw new Error('informe o telefone como argumento');

  const phoneRows = await db.select().from(contactPhones);
  const match = phoneRows.find((r) => r.phone.replace(/\D/g, '') === digits);
  if (!match) {
    console.log(`Nenhum contato com telefone ${digits}`);
    return;
  }

  const rows = await db.select().from(messages)
    .where(eq(messages.contactId, match.contactId))
    .orderBy(asc(messages.createdAt));

  for (const m of rows) {
    console.log('----------------------------------------');
    console.log(`createdAt      : ${new Date(m.createdAt as any).toISOString()}`);
    console.log(`direction/role : ${m.direction}/${m.role}`);
    console.log(`zapsterMsgId   : ${m.zapsterMessageId ?? 'NULL'}`);
    console.log(`recipientId    : ${m.recipientId ?? 'NULL'}  type=${m.recipientType ?? 'NULL'}`);
    console.log(`sendStatus     : ${m.sendStatus ?? 'NULL'} attempts=${m.sendAttempts}`);
    console.log(`toolName       : ${m.toolName ?? '-'}`);
    console.log(`text           : ${(m.text ?? '').slice(0, 70)}`);
  }
}
main().then(() => closeDb()).catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
