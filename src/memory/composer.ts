// src/memory/composer.ts
//
// Bloco 10 — Task 53. Atualizado em 2026-05-04 (várias iterações):
//   - 1ª: incluir lead snapshot (## Estado do lead atual).
//   - 2ª: incluir `## Contato` (com placeholder hint quando aplicável) +
//        `## Leads ativos do contato (atendimento ambíguo)` quando há 2+
//        leads OPEN para o mesmo contato.
//
// Compõe o pacote final que vai para o LLM. Ordem das seções no system foi
// invertida em 2026-05-05 para mitigar "L1 dominante vs prompt": estado
// dinâmico (Contato + Lead/Leads ambíguos) fica por ÚLTIMO no system, ficando
// adjacente ao L1 que vem nas messages — assim o LLM "lê" o estado logo antes
// do histórico em vez de no meio dele.
//   - `system`        : agent_configs.systemPrompt
//                       + `## Sumário do contato` (L2 — se houver)
//                       + `## Contexto temporal` (sempre)
//                       + `## Contato` (sempre que tiver nome)
//                       + `## Estado do lead atual` (1 lead) OU
//                         `## Leads ativos do contato (atendimento ambíguo)` (2+)
//   - `messages`      : L1 (lastN(15)) + a mensagem inbound deste turno
//   - `tokenEstimate` : aproximação grosseira (chars / 4) — útil para tracing
//
// O lead snapshot vem de `ctx.lead` (já hidratado pelo loop antes de
// BEFORE_REQUEST — alinhamento com contrato `load-context` do
// Harness-Architecture). NÃO faz query nova aqui; só formata.
//
// Formato do contexto temporal: `2026-05-03 22:35 BRT` (BR, hora América/SP).
// Não usamos Intl com timezone porque containers podem rodar UTC; calculamos
// offset BR (-03:00, sem horário de verão desde 2019) à mão para garantir
// determinismo.
//
// Decisão (concept memory-layers): se `ctx.message.text` é vazio (áudio sem
// transcrição), NÃO appendamos o user turn — o loop não deveria chegar aqui
// nesse caso (áudio tem rota dedicada), mas guardamos defensive.

import type { HarnessContext } from '../harness/types';
import type { LLMMessage } from '../llm/types';
import { isPlaceholderContactName } from '../contacts/resolveContact';
import { loadLastN } from './l1-conversation';
import { buildSummary } from './l2-summary';

export interface ComposedPrompt {
  /** System prompt completo (base + L2 + contexto temporal). */
  system: string;
  /** Histórico L1 + user turn atual, em ordem cronológica. */
  messages: LLMMessage[];
  /** Sumário L2 cru (sem cabeçalho). Vazio se nenhum fact qualifica. */
  l2: string;
  /** Aproximação grosseira (system + JSON.stringify(messages.content)) / 4. */
  tokenEstimate: number;
  /** Subtotais expostos para tracing (memory_loaded). */
  l1Count: number;
  l2Chars: number;
  systemChars: number;
}

const DEFAULT_LAST_N = 15;

export async function compose(ctx: HarnessContext): Promise<ComposedPrompt> {
  const baseSystem = ctx.config?.systemPrompt ?? '';

  // Lê L1 + L2 em paralelo (independentes).
  const [l1, l2] = await Promise.all([
    loadLastN(ctx.contact.id, DEFAULT_LAST_N),
    buildSummary(ctx.contact.id),
  ]);

  // Monta system: base + L2 (se houver) + contexto temporal + Contato +
  // (lead snapshot OU candidatos ambíguos). Estado dinâmico vai POR ÚLTIMO
  // para ficar adjacente ao L1 (mais "recente" para o LLM). Ver comentário
  // do header sobre L1 dominante.
  const sections: string[] = [baseSystem];

  if (l2.length > 0) {
    sections.push('## Sumário do contato', l2);
  }
  sections.push('## Contexto temporal', `Agora: ${formatNowBR()}`);

  const contactSection = renderContact(ctx.contact);
  if (contactSection.length > 0) {
    sections.push('## Contato', contactSection);
  }

  // Quando há 2+ leads ativos, prevalece a seção de desambiguação — não
  // emitimos `## Estado do lead atual` para evitar que o modelo "escolha"
  // sozinho um lead com base em snapshot parcial. A regra é: PERGUNTAR antes
  // de qualquer ação.
  if (ctx.leadCandidates && ctx.leadCandidates.length >= 2) {
    sections.push(
      '## Leads ativos do contato (atendimento ambíguo)',
      renderLeadCandidates(ctx.leadCandidates),
    );
  } else {
    const leadSection = renderLeadSnapshot(ctx.lead);
    if (leadSection.length > 0) {
      sections.push('## Estado do lead atual', leadSection);
    }
  }
  // Junta com double newline entre seções (e single dentro de uma seção quando
  // o título e corpo já são strings separadas).
  const system = sections
    .map((s, i, arr) => {
      // Inserimos `\n\n` entre seções — mas se duas adjacentes formam título+body
      // (## Sumário ↓ corpo), queremos `\n` entre elas, não `\n\n`.
      // Estratégia simples: junta tudo com `\n\n` e depois normaliza
      // `## X\n\n` → `## X\n`.
      void i;
      void arr;
      return s;
    })
    .join('\n\n')
    .replace(/(##[^\n]+)\n\n/g, '$1\n');

  // Monta messages: L1 + user turn atual (defensive: skip se text vazio).
  const messages: LLMMessage[] = [...l1];
  const inboundText = (ctx.message.text ?? '').trim();
  if (inboundText.length > 0) {
    messages.push({ role: 'user', content: inboundText });
  }

  // Token estimate: chars / 4 (aproximação ASCII; um pouco generosa para PT-BR
  // mas suficiente para alertas/tracing).
  const messagesChars = messages.reduce((acc, m) => {
    if (typeof m.content === 'string') return acc + m.content.length;
    return acc + JSON.stringify(m.content).length;
  }, 0);
  const tokenEstimate = Math.ceil((system.length + messagesChars) / 4);

  return {
    system,
    messages,
    l2,
    tokenEstimate,
    l1Count: l1.length,
    l2Chars: l2.length,
    systemChars: system.length,
  };
}

/**
 * Formata "agora" no padrão `YYYY-MM-DD HH:MM BRT` (UTC-03, sem DST).
 *
 * NÃO usamos `toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'})` porque
 * (a) depende do tzdata do container, (b) já não há DST no BR desde 2019.
 * Cálculo offset à mão garante saída determinística independente do host.
 */
function formatNowBR(): string {
  const now = new Date();
  // Aplica -3h.
  const br = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = br.getUTCFullYear();
  const mm = pad2(br.getUTCMonth() + 1);
  const dd = pad2(br.getUTCDate());
  const hh = pad2(br.getUTCHours());
  const mi = pad2(br.getUTCMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} BRT`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Formata a seção `## Contato` do system prompt. Sempre presente quando o
 * nome está disponível.
 *
 * Quando o nome ainda é o placeholder `WhatsApp <phone>` (auto-criação sem
 * renomeação posterior), adiciona uma instrução para a Angelina pedir o nome
 * naturalmente e atualizar via `save_lead_info(contact_name=…)`.
 */
function renderContact(contact: HarnessContext['contact']): string {
  const name = (contact.name ?? '').trim();
  if (name.length === 0) return '';

  const lines: string[] = [`Nome: ${name}`];
  if (isPlaceholderContactName(name)) {
    lines.push(
      '(Nome ainda não confirmado — pergunte o nome do cliente de forma natural ' +
        'no momento adequado da conversa e, ao receber, chame ' +
        '`save_lead_info` com `contact_name` preenchido.)',
    );
  }
  return lines.join('\n');
}

/**
 * Formata a seção `## Leads ativos do contato (atendimento ambíguo)` quando
 * há 2+ leads OPEN para o contato. Lista os candidatos e instrui a Angelina
 * a perguntar antes de tomar qualquer ação.
 *
 * Importante (regra de negócio): NÃO chamar nenhuma tool até o cliente
 * desambiguar. A Angelina pergunta naturalmente, espera resposta e só então
 * usa `save_lead_info(lead_id=…)` para vincular o turno ao lead correto.
 */
function renderLeadCandidates(
  candidates: NonNullable<HarnessContext['leadCandidates']>,
): string {
  const lines: string[] = [
    '**SOBRESCREVE QUALQUER INFERÊNCIA DO HISTÓRICO.** Mesmo que o histórico de mensagens sugira fortemente um evento específico, IGNORE essa inferência e PERGUNTE ao cliente para desambiguar antes de qualquer ação.',
    '',
    'Existem múltiplos eventos abertos para este contato:',
  ];
  for (const c of candidates) {
    const parts: string[] = [];
    if (c.eventType) parts.push(c.eventType);
    if (c.eventDate) parts.push(c.eventDate);
    if (c.guestCount !== null && c.guestCount !== undefined) {
      parts.push(`${c.guestCount} convidados`);
    }
    if (c.classification) parts.push(`classificação ${c.classification}`);
    if (c.lastActivityAt) {
      parts.push(`última atividade ${c.lastActivityAt}`);
    }
    const detail = parts.length > 0 ? parts.join(', ') : 'sem dados ainda';
    lines.push(`- ID ${c.id} — ${detail}`);
  }
  lines.push(
    '',
    'NÃO chame nenhuma tool e NÃO assuma sozinha qual evento é. Pergunte ao ' +
      'cliente de forma natural — algo como: "Você está falando sobre qual ' +
      'desses eventos?" — e aguarde a resposta. Só depois, com o evento ' +
      'identificado, chame `save_lead_info` passando `lead_id` do evento ' +
      'escolhido.',
  );
  return lines.join('\n');
}

/**
 * Formata os campos qualificadores do lead em linhas `Label: valor` para
 * a seção `## Estado do lead atual` do system prompt.
 *
 * Lê SOMENTE de `ctx.lead` — não faz IO. Os dados foram hidratados pelo loop
 * antes de BEFORE_REQUEST (alinhamento com contrato `load-context`).
 *
 * Retorna `''` quando:
 *   - `ctx.lead === null` (contato sem lead); OU
 *   - lead existe mas todos os campos qualificadores são null/vazios
 *     (lead recém-criado por save_lead_info sem nenhum dado ainda).
 */
function renderLeadSnapshot(lead: HarnessContext['lead']): string {
  if (!lead) return '';

  const fields: string[] = [];
  if (lead.classification) {
    fields.push(`Classificação: ${lead.classification}`);
  }
  if (lead.eventType) {
    fields.push(`Tipo de evento: ${lead.eventType}`);
  }
  if (lead.eventDate) {
    fields.push(`Data do evento: ${lead.eventDate}`);
  }
  if (lead.guestCount !== null && lead.guestCount !== undefined) {
    fields.push(`Convidados: ${lead.guestCount}`);
  }
  if (lead.estimatedBudget) {
    fields.push(`Orçamento estimado: R$ ${lead.estimatedBudget}`);
  }
  if (lead.preferences) {
    fields.push(`Preferências: ${lead.preferences}`);
  }
  if (lead.notes) {
    fields.push(`Anotações: ${lead.notes}`);
  }
  if (lead.visitScheduledAt) {
    fields.push(`Visita agendada: ${lead.visitScheduledAt}`);
  }

  if (fields.length === 0) return '';

  return [
    '**Os campos abaixo são a fonte da verdade do lead atual. Se o histórico de mensagens sugerir algo diferente, prevalece esta seção.**',
    '',
    ...fields,
  ].join('\n');
}
