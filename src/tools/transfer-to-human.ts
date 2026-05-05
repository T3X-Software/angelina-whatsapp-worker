// src/tools/transfer-to-human.ts
//
// Bloco 7 — Task 42. Tool `transfer_to_human`.
//
// Responsabilidade:
//   - SINALIZAR ao loop que o agente deve transferir o atendimento para um
//     humano. Retorna `{trigger_handoff: true}` em `data`.
//   - Emitir trace `handoff_requested` com payload (lead, motivo, prioridade)
//     para auditoria — a contagem desses traces vs `handoff_complete` revela
//     se algum sinal não chegou ao hook.
//
// Esta tool é PURA (invariante 4):
//   - NÃO escreve `leads.is_human_active` — quem escreve é o hook
//     `transfer-trigger` (Bloco 6, passo 1 da sequência 5).
//   - NÃO envia mensagem — quem envia é o hook `transfer-trigger`
//     (passos 2 e 4 da sequência).
//   - NÃO cria task / timeline_event — também responsabilidade do hook.
//
// O loop, ao receber este `ToolResult`, faz:
//   1. ctx.handoffRequested = true
//   2. Persiste tool_result em messages (com role='tool', tool_name=...)
//   3. AFTER_MODEL hooks rodam — transfer-trigger detecta e executa os 5 passos.
//
// Razão da separação:
//   - tools são puras = fáceis de testar, idempotentes, sem side-effects de
//     comunicação externa. São o "intent" do LLM.
//   - hooks são orquestradores = decidem quando + como aplicar o efeito real
//     no mundo (banco + WhatsApp), respeitando invariantes globais
//     (response-guard, idempotência, ordering).

import { z } from 'zod';

import type { HarnessContext, Tool, ToolResult } from '../harness/types';

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    reason: z.string().max(500).optional(),
    priority: z.enum(['urgent', 'normal']).default('normal'),
  })
  .strict();

type TransferToHumanInput = z.infer<typeof inputSchema>;

interface TransferToHumanOutput {
  /** Sinal lido pelo loop e propagado para o hook transfer-trigger. */
  trigger_handoff: true;
  reason?: string;
  priority: 'urgent' | 'normal';
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

async function execute(
  input: TransferToHumanInput,
  ctx: HarnessContext,
): Promise<ToolResult<TransferToHumanOutput>> {
  // Trace para auditoria. info severity — handoff é fluxo esperado, não erro.
  ctx.eventBus.emit(
    'handoff_requested',
    {
      lead_id: ctx.lead?.id ?? null,
      contact_id: ctx.contact.id,
      reason: input.reason ?? null,
      priority: input.priority,
      source: 'tool:transfer_to_human',
    },
    'info',
  );

  return {
    success: true,
    data: {
      trigger_handoff: true,
      reason: input.reason,
      priority: input.priority,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const transferToHumanTool: Tool<
  TransferToHumanInput,
  TransferToHumanOutput
> = {
  name: 'transfer_to_human',
  description:
    'Sinaliza que o atendimento precisa ser transferido para um humano da ' +
    'equipe (ex: cliente pediu falar com pessoa real, dúvida fora do escopo, ' +
    'lead pronto para fechar contrato). Use priority="urgent" só se o cliente ' +
    'demonstrar pressa explícita ou risco de perder o lead. NÃO escreve no ' +
    'banco e NÃO envia mensagem — o sistema executa a transição automaticamente ' +
    'após esta tool retornar (envia mensagem de transição ao cliente, notifica ' +
    'a equipe, cria task de follow-up).',
  inputSchema,
  execute,
};
