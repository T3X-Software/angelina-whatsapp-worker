// src/edge/detect-support-inbound.ts
//
// Bloco 9 — feature `whatsapp-message-splitting-and-handoff-continuity`.
//
// Detecção da 1ª resposta do vendedor (support_whatsapp) ao cliente após um
// handoff HOT. Quando o vendedor responde no WhatsApp do bot, este módulo:
//
//   1. Acha a task FOLLOWUP HIGH ativa cujo `assigned_to_phone` casa com o
//      sender (denormalização populada por `transfer-trigger` no Bloco 9 —
//      coluna `tasks.assigned_to_phone` criada pela migration
//      20260509000000_handoff_continuity, decisão D5).
//   2. Se achou: SET `leads.handoff_assumed_at = NOW()` com guard
//      `WHERE handoff_assumed_at IS NULL` (idempotente — protege contra race
//      com `/assumi` admin do Bloco 8 e contra reentrância em mensagens
//      consecutivas do mesmo vendedor).
//
// O caller (consumer.ts) decide o que fazer com o resultado:
//   - `detected:true` → emit `handoff_assumed_via_webhook` + retornar SEM
//     enfileirar para o HarnessLoop (mensagem do vendedor não é turno do
//     cliente).
//   - `detected:false` → vendedor sem task ativa (uso pessoal do número?) —
//     descartar silenciosamente, NÃO virar turno.
//
// Invariantes preservadas:
//   - #4 (tools não enviam mensagens): este módulo NÃO envia nada — só faz
//     SELECT + UPDATE. Quem envia o aviso "handoff confirmado" ao cliente
//     (se algum dia for adicionado) seria responsabilidade do response-guard
//     ou de um hook futuro, não desta função.
//   - #10 (idempotência via UNIQUE): NÃO duplica lógica — usa `WHERE
//     handoff_assumed_at IS NULL` para garantir só-uma-vez. UNIQUE de
//     `messages.zapster_message_id` continua sendo a 1ª camada (mas messages
//     do vendedor nem chegam a entrar em `messages`, ver consumer.ts).
//
// Performance: 2 round-trips por chamada (1 SELECT + 1 UPDATE condicional).
// Rodado fora do hot-path do webhook (post fast-ACK), no consumer BullMQ.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';

/**
 * Resultado discriminado da detecção.
 *
 * - `detected:true`: havia task ativa para este support_phone.
 *   `alreadyAssumed:true` significa que o lead já tinha `assumed_at` setado
 *   antes desta chamada (idempotente; emit informativo, não duplica timestamp).
 * - `detected:false`: nenhuma task FOLLOWUP HIGH open para o sender. Vendedor
 *   pode estar usando o número para outros fins (uso pessoal, conversa fora
 *   de fluxo de handoff). Descartar silenciosamente.
 */
export type SupportInboundResult =
  | { detected: true; leadId: string; alreadyAssumed: boolean }
  | { detected: false; reason: 'no_active_task' };

interface TaskRow {
  lead_id: string;
  [key: string]: unknown;
}

interface UpdateRow {
  id: string;
  [key: string]: unknown;
}

/**
 * Detecta se uma mensagem ENTRANTE de `sourcePhone` representa a 1ª
 * resposta de um vendedor a um lead em handoff. Se sim, atualiza
 * `leads.handoff_assumed_at` (idempotente).
 *
 * `sourcePhone` deve estar no formato Zapster (sem `+`, ex `5519974131955`).
 * O caller é responsável por já ter validado que o phone é support
 * (`isSupportPhone(...)` em `consumer.ts`) — esta função NÃO valida
 * autorização, apenas executa a query.
 */
export async function detectSupportInbound(
  sourcePhone: string,
): Promise<SupportInboundResult> {
  // 1) Buscar task FOLLOWUP HIGH ainda aberta atribuída a este vendedor.
  //    `status='PENDING'` é o valor real do enum `task_status` (ver schema:
  //    PENDING/IN_PROGRESS/DONE/CANCELLED). O brief diz "open" como conceito;
  //    no banco isso é PENDING (task ainda não concluída).
  //    Usamos `LIMIT 1` + `ORDER BY created_at DESC` — se houver múltiplas
  //    tasks ativas para o mesmo vendedor (cenário possível em volume), a
  //    mais recente é a mais provável de corresponder ao handoff que está
  //    sendo respondido agora.
  const taskRows = await db.execute<TaskRow>(sql`
    SELECT lead_id::text AS lead_id
      FROM tasks
     WHERE assigned_to_phone = ${sourcePhone}
       AND status            = 'PENDING'::task_status
       AND type              = 'FOLLOWUP'::task_type
       AND priority          = 'HIGH'::task_priority
       AND lead_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1
  `);
  const arr = Array.from(taskRows) as TaskRow[];
  if (arr.length === 0) {
    return { detected: false, reason: 'no_active_task' };
  }
  const leadId = arr[0].lead_id;

  // 2) UPDATE idempotente — só seta se ainda NULL. Race-safe contra
  //    /assumi admin do Bloco 8 (que usa o mesmo guard).
  //    `RETURNING id` retorna 0 rows quando o WHERE não casa — significa que
  //    `handoff_assumed_at` já estava setado (admin assumiu antes ou nova
  //    inbound do mesmo vendedor). Tratamos como `alreadyAssumed:true`.
  const updRows = await db.execute<UpdateRow>(sql`
    UPDATE leads
       SET handoff_assumed_at = now(),
           updated_at         = now()
     WHERE id = ${leadId}::uuid
       AND handoff_assumed_at IS NULL
    RETURNING id::text AS id
  `);
  const updArr = Array.from(updRows) as UpdateRow[];
  const alreadyAssumed = updArr.length === 0;

  return { detected: true, leadId, alreadyAssumed };
}

/**
 * Helper futuro-proof: aceita `support_whatsapp` como string única OU array.
 * Hoje (v3) é text (string única); se evoluir para array no futuro, esta
 * função tolera sem mudanças no caller.
 *
 * Comparação literal (sem normalização). O formato consolidado do projeto
 * é "phone sem `+`" (memória `project_phone_format_convention`), e tanto o
 * payload do Zapster quanto `agent_configs.support_whatsapp` seguem essa
 * convenção. Se algum lado divergir, casamento falha — comportamento
 * desejado (fail-closed).
 */
export function isSupportPhone(
  sourcePhone: string,
  supportConfig: string | string[] | null | undefined,
): boolean {
  if (!sourcePhone) return false;
  if (supportConfig === null || supportConfig === undefined) return false;
  if (typeof supportConfig === 'string') {
    const trimmed = supportConfig.trim();
    if (trimmed === '') return false;
    return trimmed === sourcePhone;
  }
  if (Array.isArray(supportConfig)) {
    return supportConfig.some(
      (p) => typeof p === 'string' && p.trim() === sourcePhone,
    );
  }
  return false;
}
