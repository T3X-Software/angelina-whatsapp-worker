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
//
// ─────────────────────────────────────────────────────────────────────────────
// Bloco 6 — feature `whatsapp-message-splitting-and-handoff-continuity`
// (tool-gating, defesa em profundidade camada 3):
//
// Antes de qualquer trabalho, a tool checa se o lead já está em modo assistido
// (is_human_active=true && handoff_assumed_at IS NULL). Se sim, retorna ERRO
// sem persistir nada — ZERO efeito colateral. Razão: nesse estado, um
// handoff já foi disparado e o humano ainda não confirmou. Disparar OUTRO
// handoff seria ruído (cliente recebe nova "vou te transferir", task duplicada,
// timeline poluído).
//
// O retorno tem `success: false` e mensagem descritiva — o ctx.lastToolCall.result
// chega ao Claude como tool_result com `is_error: true` (anthropic semantics)
// e o LLM tem 4 iterações restantes (invariante #6 = max 5) para reconsiderar.
// Se persistir tentando, o response-guard (camada 1) e o classifier (camada 2)
// ainda interceptam mensagens sensíveis.
//
// O gate roda em modo `blocked` (handoff confirmado) também? NÃO — em blocked
// a tool nunca deveria ser invocada porque o response-guard bloqueia toda
// resposta da IA antes de qualquer coisa chegar ao cliente. Mas se Claude
// chamar a tool dentro do mesmo turno (e o response-guard ainda não rodou),
// o gate da tool retorna `success: true` para `blocked` (tool é idempotente
// pra esse cenário — re-disparar handoff de lead já confirmado é raro mas
// não dá inconsistência: o transfer-trigger usa COALESCE em interest_summary/
// suggested_action). O foco do gate é APENAS modo assistido transitório.
// ─────────────────────────────────────────────────────────────────────────────
//
// Bloco 3 — feature `whatsapp-message-splitting-and-handoff-continuity`
// (decisão T3.1, log 2026-05-09 15:02):
//
// Adicionados 2 args OPCIONAIS — `interest_summary` e `suggested_action` —
// que o LLM pode passar para humanizar a mensagem que o `transfer-trigger`
// envia ao número de suporte (`agent_configs.support_whatsapp`):
//
//   - `interest_summary`: resumo curto do interesse atual do cliente,
//     baseado nas últimas mensagens (ex: "quer saber mais sobre gastronomia
//     e valores"). Para o especialista entender contexto antes de ligar.
//
//   - `suggested_action`: ação prescritiva sugerida ao especialista (ex:
//     "Entrar em contato para apresentar proposta, explicar gastronomia
//     e alinhar valores").
//
// Ambos viajam via `data` deste ToolResult e são lidos pelo `transfer-trigger`
// através de `ctx.lastToolCall.input` (Bloco 7 da harness inbound) — o hook
// faz o UPDATE em `leads.interest_summary` e `leads.suggested_action` dentro
// da MESMA transação atômica do passo 1 (UPDATE is_human_active=true).
//
// Por que NÃO persistir aqui na tool?
//   - Invariante #4 forte: tools são puras, ZERO I/O.
//   - Atomicidade: se a tool persistisse e o hook falhasse depois, leads
//     ficaria com interest_summary/suggested_action mas SEM is_human_active
//     setado — estado inconsistente. Centralizar tudo no transaction do hook
//     elimina essa janela de race.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import type { HarnessContext, Tool, ToolResult } from '../harness/types';
import { getLeadHandoffState, isAssistedMode } from '../utils/assisted-mode';

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    reason: z.string().max(500).optional(),
    priority: z.enum(['urgent', 'normal']).default('normal'),
    interest_summary: z.string().max(500).optional(),
    suggested_action: z.string().max(500).optional(),
  })
  .strict();

type TransferToHumanInput = z.infer<typeof inputSchema>;

interface TransferToHumanOutput {
  /** Sinal lido pelo loop e propagado para o hook transfer-trigger. */
  trigger_handoff: true;
  reason?: string;
  priority: 'urgent' | 'normal';
  /** Bloco 3: snapshot do interesse atual (consumido pelo transfer-trigger). */
  interest_summary?: string;
  /** Bloco 3: ação prescritiva sugerida (consumida pelo transfer-trigger). */
  suggested_action?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

async function execute(
  input: TransferToHumanInput,
  ctx: HarnessContext,
): Promise<ToolResult<TransferToHumanOutput>> {
  // Bloco 6 — Tool-gating (defesa em profundidade, camada 3).
  // Modo assistido (is_human_active=true && handoff_assumed_at IS NULL):
  // handoff já foi disparado, humano ainda não assumiu. Disparar OUTRO
  // handoff seria ruído. Retorna erro descritivo SEM persistir nada.
  //
  // Defensive: se a query falhar (ex: race com delete do lead), `try/catch`
  // tolera e libera a tool — defesa em profundidade preserva (response-guard
  // e classifier ainda atuam se algo escapar). Emit `note` para observabilidade.
  let state;
  try {
    state = await getLeadHandoffState(ctx.lead?.id ?? null);
  } catch (err) {
    ctx.eventBus.emit(
      'tool_gate_lookup_failed',
      {
        tool: 'transfer_to_human',
        lead_id: ctx.lead?.id ?? null,
        contact_id: ctx.contact.id,
        error: err instanceof Error ? err.message : String(err),
      },
      'med',
    );
    state = { mode: 'free' as const };
  }

  if (isAssistedMode(state)) {
    ctx.eventBus.emit(
      'tool_blocked_assisted_mode',
      {
        tool: 'transfer_to_human',
        lead_id: ctx.lead?.id ?? null,
        contact_id: ctx.contact.id,
        reason_attempted: input.reason ?? null,
        priority_attempted: input.priority,
      },
      'info',
    );

    return {
      success: false,
      error:
        'transfer_to_human indisponível: o lead já está em handoff assistido ' +
        '(especialista a caminho, ainda não respondeu). Continue conversando ' +
        'com o cliente normalmente; tópicos sensíveis (preço, agendamento, ' +
        'fechar contrato) você redireciona com "o especialista vai te ajudar com isso". ' +
        'NÃO chame esta tool de novo neste turno.',
    };
  }

  // Trace para auditoria. info severity — handoff é fluxo esperado, não erro.
  ctx.eventBus.emit(
    'handoff_requested',
    {
      lead_id: ctx.lead?.id ?? null,
      contact_id: ctx.contact.id,
      reason: input.reason ?? null,
      priority: input.priority,
      has_interest_summary: input.interest_summary != null,
      has_suggested_action: input.suggested_action != null,
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
      interest_summary: input.interest_summary,
      suggested_action: input.suggested_action,
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
    'demonstrar pressa explícita ou risco de perder o lead. ' +
    'Você pode (e DEVE, sempre que possível) passar dois campos opcionais ' +
    'que ajudam o especialista a entrar no atendimento já com contexto: ' +
    '`interest_summary` (resumo curto do interesse atual do cliente baseado ' +
    'nas últimas mensagens, ex: "quer saber mais sobre gastronomia e valores") ' +
    'e `suggested_action` (ação prescritiva sugerida ao especialista, ex: ' +
    '"Entrar em contato para apresentar proposta, explicar gastronomia e ' +
    'alinhar valores"). Esses dois campos são exibidos na mensagem que o ' +
    'sistema envia ao número de suporte. NÃO escreve no banco e NÃO envia ' +
    'mensagem — o sistema executa a transição automaticamente após esta tool ' +
    'retornar (envia mensagem de transição ao cliente, notifica a equipe ' +
    'com os campos acima, cria task de follow-up). ' +
    'IMPORTANTE: NÃO chame esta tool se um handoff já está em andamento neste ' +
    'lead (modo assistido — especialista a caminho mas ainda não respondeu). ' +
    'Nesse caso a tool retorna erro e seu trabalho é continuar conversando ' +
    'com o cliente normalmente, redirecionando tópicos sensíveis ao especialista.',
  inputSchema,
  execute,
};
