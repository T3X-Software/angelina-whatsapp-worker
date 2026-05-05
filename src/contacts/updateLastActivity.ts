// src/contacts/updateLastActivity.ts
//
// Bloco 4 — Task 24.
//
// Atualiza `leads.last_activity_at = now()`. Chamada pelo HarnessLoop ao
// final de cada turno bem-sucedido (Bloco 5). Mantém o desempate de
// `resolveActiveLead` (caso o contato tenha mais de um lead OPEN, o que foi
// mexido por último é considerado o ativo).
//
// Fire-and-forget: o caller não precisa aguardar resultado nem ler nada de
// volta. Erros não devem derrubar o turno (já enviamos a resposta) — capturar
// no caller via try/catch e logar.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { leads } from '../db/schema';

/**
 * UPDATE leads SET last_activity_at = now() WHERE id = $1.
 *
 * Não retorna nada. Se o `leadId` não existir, o UPDATE acerta 0 linhas e
 * passa silenciosamente — comportamento intencional (o caller já tem o id
 * de um lead válido vindo do `resolveActiveLead`; se foi deletado entre
 * o resolve e o update, ignorar).
 */
export async function updateLastActivity(leadId: string): Promise<void> {
  await db
    .update(leads)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(leads.id, leadId));
}
