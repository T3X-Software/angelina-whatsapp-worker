// src/harness/turn-tracker.ts
//
// Bloco 2 — Tasks 10/11 da feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Singleton in-memory que rastreia o turno corrente de cada contato.
//
// Sub-decisão T2.1 (Bloco 2, registrada no implementation-log): usar
// Map<contactId, turnId> in-memory em vez de coluna `contacts.current_turn_id`
// no banco. Justificativa:
//   - `turn.id` JÁ é `messages.id` (decisão Bloco 5 #25/#26) — naturalmente único.
//   - Worker é processo contínuo (Docker/PM2). Restart entre split-1 e split-2
//     é cenário negligível.
//   - response-guard JÁ protege via 3 outras regras (HUMAN_TAKEOVER, PAUSED,
//     is_human_active). Stale-turn guard é defesa adicional, não principal.
//   - Custo zero: sem migration, sem +1 query/send.
//
// Limitações conhecidas e aceitas:
//   - Não funciona em deploy multi-worker horizontal (precisaria Redis/lock).
//     Hoje deploy é single-worker em VPS — aceito.
//   - Restart do worker no meio do split = última parte ainda no buffer da
//     fila pode enviar mesmo após nova mensagem inbound. Probabilidade baixa,
//     impacto baixo (no máximo 1 mensagem stale).
//
// API:
//   - setCurrentTurn(contactId, turnId) — chamado no início do turno (loop).
//   - isCurrentTurn(contactId, turnId) — chamado pelo response-guard antes de
//     cada parte do split.
//   - clearCurrentTurn(contactId) — utilitário para testes.
//   - _internals — Map exposto para smokes inspecionarem.

const currentTurnByContact: Map<string, string> = new Map();

/**
 * Registra `turnId` como o turno corrente do contato `contactId`. Sobrescreve
 * qualquer turno anterior — chamada por turno (no início, após resolver
 * messageId).
 */
export function setCurrentTurn(contactId: string, turnId: string): void {
  currentTurnByContact.set(contactId, turnId);
}

/**
 * Retorna o turnId corrente registrado para `contactId`, ou `undefined` se
 * nenhum turno foi registrado ainda (cold-start, primeiro turno do contato
 * neste boot do worker).
 */
export function getCurrentTurn(contactId: string): string | undefined {
  return currentTurnByContact.get(contactId);
}

/**
 * `true` se `turnId` é o turno corrente de `contactId` OR se nenhum turno
 * foi registrado (cold-start defensivo: na ausência de informação, NÃO
 * assumir stale — deixa passar; outras regras do response-guard cuidam).
 *
 * Retorno `false` apenas quando há um turno registrado E é diferente do
 * passado — única condição que indica claramente "esta parte é stale, descarte".
 */
export function isCurrentTurn(contactId: string, turnId: string): boolean {
  const current = currentTurnByContact.get(contactId);
  if (current === undefined) return true;
  return current === turnId;
}

/**
 * Remove o turno corrente do contato. Útil em testes para isolar cenários;
 * em prod, não é necessário chamar (o `set` da próxima entrada sobrescreve).
 */
export function clearCurrentTurn(contactId: string): void {
  currentTurnByContact.delete(contactId);
}

/**
 * Internals expostos APENAS para smokes/tests inspecionarem o estado do Map.
 * NÃO usar em código de produção — sem contrato de estabilidade.
 */
export const _internals = {
  currentTurnByContact,
};
