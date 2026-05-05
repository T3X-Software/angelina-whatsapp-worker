// src/zapster/sender.ts
//
// Bloco 9 — Task 50. Sender de alto nível com state machine atômica.
//
// Concept: `outbound-state-machine` (4 estados, transição anti-double-send).
//
// Lógica:
//   1. Transição atômica `pending → sending`:
//        UPDATE messages
//           SET send_status='sending',
//               send_attempts = send_attempts + 1,
//               send_attempted_at = now()
//         WHERE id=$1 AND send_status='pending'
//        RETURNING id;
//      Se 0 rows → outro worker pegou a mesma mensagem (race lost) → return.
//   2. Try `client.send(input)`:
//      - Sucesso: UPDATE send_status='sent', zapster_message_id.
//        CHECK_3 (`messages_sent_requires_ack_chk`) exige
//        `zapster_message_id NOT NULL` AND `send_attempted_at NOT NULL` —
//        ambos garantidos (send_attempted_at foi setado na transição
//        atômica do passo 1; coluna `sent_at` NÃO existe na tabela).
//      - Erro: UPDATE send_status='failed' + emit `zapster_send_failure` (high)
//        com `{outbound_id, error, status_code}`.
//
// ⚠️ Esta função é chamada SOMENTE pelo HarnessLoop (após response-guard).
// Hooks `transfer-trigger` (passos 2 + 4) e `human-delay` (typing) continuam
// chamando `client.send()` direto (invariante 5 — bypass response-guard
// autorizado e documentado).

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { EventBus } from '../harness/types';
import type { ZapsterClient } from './client';
import { ZapsterError, type ZapsterSendInput } from './types';

export type SenderStatus = 'sent' | 'failed' | 'race_lost';

export interface SenderResult {
  status: SenderStatus;
  /** Presente quando `status='sent'`. */
  zapsterMessageId?: string;
  /** Presente quando `status='failed'`. */
  error?: string;
  /** HTTP status code da Zapster, se conhecido. 0 = desconhecido. */
  statusCode?: number;
}

/**
 * Envia 1 outbound aplicando a state machine atômica.
 *
 * @param outboundMessageId  uuid do row em `messages` (criado em pending pelo loop).
 * @param client             instância do `ZapsterClient` (com retry interno).
 * @param input              `{recipientId, recipientType, text}` para o Zapster.
 * @param bus                EventBus do turno — emit `zapster_send_failure`/etc.
 */
export async function sendWithStateMachine(
  outboundMessageId: string,
  client: ZapsterClient,
  input: ZapsterSendInput,
  bus: EventBus,
): Promise<SenderResult> {
  // [1] Transição atômica pending → sending.
  // Repetimos `WHERE send_status='pending'` para que 2 workers concorrentes
  // não consigam ambos transicionar (Postgres atomiza o UPDATE).
  const claim = await db.execute<{ id: string }>(sql`
    UPDATE messages
       SET send_status = 'sending',
           send_attempts = send_attempts + 1,
           send_attempted_at = now()
     WHERE id = ${outboundMessageId} AND send_status = 'pending'
    RETURNING id
  `);
  const claimRows = Array.from(claim) as Array<{ id: string }>;
  if (claimRows.length === 0) {
    // Race perdida — outro worker já pegou. NÃO conta tentativa
    // (send_attempts não foi incrementado para nós).
    bus.emit(
      'zapster_send_race_lost',
      { outbound_id: outboundMessageId },
      'info',
    );
    return { status: 'race_lost' };
  }

  // [2] Try client.send.
  bus.emit(
    'zapster_send_dispatch',
    { outbound_id: outboundMessageId },
    'info',
  );
  try {
    const result = await client.send(input);
    // [2a] Sucesso → sending → sent. Seta zapster_message_id.
    // CHECK_3: send_status='sent' exige zapster_message_id E send_attempted_at
    // NOT NULL — send_attempted_at já foi setado no passo 1.
    // (Coluna `sent_at` NÃO existe na tabela — usar `send_attempted_at`.)
    await db.execute(sql`
      UPDATE messages
         SET send_status = 'sent',
             zapster_message_id = ${result.zapsterMessageId}
       WHERE id = ${outboundMessageId} AND send_status = 'sending'
    `);
    bus.emit(
      'zapster_send_success',
      {
        outbound_id: outboundMessageId,
        zapster_message_id: result.zapsterMessageId,
      },
      'info',
    );
    return { status: 'sent', zapsterMessageId: result.zapsterMessageId };
  } catch (err) {
    // [2b] Falha → sending → failed. Emit alerta (high).
    const errMessage = err instanceof Error ? err.message : String(err);
    const statusCode = err instanceof ZapsterError ? err.statusCode : 0;

    try {
      await db.execute(sql`
        UPDATE messages
           SET send_status = 'failed'
         WHERE id = ${outboundMessageId} AND send_status = 'sending'
      `);
    } catch (updateErr) {
      // Se nem o UPDATE de failed funcionar (DB down?), ainda emitimos a falha
      // do send original — o turno top-level também vai pegar.
      const updMsg =
        updateErr instanceof Error ? updateErr.message : String(updateErr);
      bus.emit(
        'zapster_send_failure_persist_failed',
        {
          outbound_id: outboundMessageId,
          original_error: errMessage,
          persist_error: updMsg,
        },
        'high',
      );
    }

    bus.emit(
      'zapster_send_failure',
      {
        outbound_id: outboundMessageId,
        error: errMessage,
        status_code: statusCode,
      },
      'high',
    );

    return { status: 'failed', error: errMessage, statusCode };
  }
}
