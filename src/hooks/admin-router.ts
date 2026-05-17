// src/hooks/admin-router.ts
//
// Bloco 6 — Task 33 (feature `harness-worker-inbound`).
// Bloco 8 — Tasks #33-#36 (feature `whatsapp-message-splitting-and-handoff-continuity`).
//
// BEFORE_REQUEST (entre rate-limit-guard e load-context).
//
// Detecta comandos administrativos enviados por números na whitelist
// `agent_configs.hookParams.admin_phones`. Quando aciona, escreve
// `contacts.ai_state` (controle MANUAL — concept `ai-state-control`) e/ou
// `leads.handoff_assumed_at` + `leads.is_human_active` (controle do estado
// 3-fases do handoff — concept `ai-state-control` atualizado pela feature
// `whatsapp-message-splitting-and-handoff-continuity` Bloco 8), e
// short-circuita o turno com uma resposta curta de confirmação.
//
// Comandos atuais:
//   - `/pausar`     → ai_state=PAUSED         (admin-only)
//   - `/retomar`    → ai_state=AUTO           (admin-only)
//   - `/transferir` → ai_state=HUMAN_TAKEOVER (admin-only)
//   - `/status`     → resposta read-only      (admin-only)
//   - `/limpar`     → soft-redact L1 do contato  (PÚBLICO — ver FIXME abaixo)
//   - `/assumi <lead_id>`   → SET handoff_assumed_at=NOW   (admin-only) [Bloco 8]
//   - `/devolver <lead_id>` → SET is_human_active=false +
//                              handoff_assumed_at=NULL      (admin-only) [Bloco 8]
//   - `/reativar-followup <phone>` → SET leads.follow_up_disabled=false do lead
//                              ativo (status=OPEN) do contato (admin-only)
//                              [feature follow-up-pendente, Bloco 6]
//
// Decisão (registrada no log do Bloco 6 — abertura): a `response` retornada
// neste hook (ex.: "✅ Agente pausado.") fica no contexto via `responseToSend`
// no `loop.ts`. Quem efetivamente envia ao admin é decidido no Bloco 9 (canal
// próprio fora do pipeline normal — response-guard nem roda porque o turno
// foi cortado em BEFORE_REQUEST).
//
// IMPORTANTE: Comandos `/pausar`/`/retomar`/`/transferir` mexem APENAS em
// `contacts.ai_state` (controle por contato — invariante #7). Comandos
// `/assumi`/`/devolver` mexem APENAS em `leads.handoff_assumed_at` +
// `leads.is_human_active` (controle por lead — invariante #7 mantido). NÃO
// chama LLM (invariante 3). NÃO envia mensagem neste arquivo (invariante 4).

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import type { Hook, HookResult, HarnessContext } from '../harness/types';

type AdminCommand =
  | 'pausar'
  | 'retomar'
  | 'transferir'
  | 'status'
  | 'limpar'
  | 'assumi'
  | 'devolver'
  | 'reativar-followup';

interface HookParamsShape {
  admin_phones?: string[];
}

// Importante: `reativar-followup` vem ANTES de outras alternativas que poderiam
// fazer prefix-match (não há risco atual; convenção defensiva).
const ADMIN_REGEX =
  /^\s*\/(reativar-followup|pausar|retomar|transferir|status|limpar|assumi|devolver)\b\s*(.*)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// /reativar-followup helpers (feature follow-up-pendente, Bloco 6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formato Zapster: phone sem `+`, dígitos contínuos (ex: '5519997124472').
 * Mínimo 10 dígitos (cobre prefixo de teste `5500000XXX`).
 */
const PHONE_REGEX = /^\d{10,15}$/;

interface ContactPhoneResolveRow {
  contact_id: string;
  contact_name: string | null;
  lead_id: string | null;
  lead_follow_up_disabled: boolean | null;
  [key: string]: unknown;
}

/**
 * Resolve `(contact_id, name, active_lead_id, follow_up_disabled)` a partir de
 * um phone. 1 query com LEFT JOIN — devolve `null` quando phone não existe;
 * devolve `{lead_id: null}` quando o contato não tem lead OPEN.
 */
async function resolveContactByPhoneForReactivation(
  phone: string,
): Promise<ContactPhoneResolveRow | null> {
  const rows = await db.execute<ContactPhoneResolveRow>(sql`
    SELECT
      c.id::text                          AS contact_id,
      c.name                              AS contact_name,
      l.id::text                          AS lead_id,
      l.follow_up_disabled                AS lead_follow_up_disabled
    FROM contact_phones cp
    JOIN contacts c       ON c.id = cp.contact_id
    LEFT JOIN LATERAL (
      SELECT id, follow_up_disabled
        FROM leads
       WHERE contact_id = c.id
         AND status = 'OPEN'
       ORDER BY last_activity_at DESC
       LIMIT 1
    ) l ON true
    WHERE cp.phone = ${phone}
    LIMIT 1
  `);
  const arr = Array.from(rows) as ContactPhoneResolveRow[];
  return arr.length > 0 ? arr[0] : null;
}

/** Comandos liberados para QUALQUER phone durante o hardening local.
 *  FIXME(testing): voltar para admin-only antes de produção (mover `limpar`
 *  para o conjunto admin junto com pausar/retomar/transferir/status). */
const PUBLIC_COMMANDS: ReadonlySet<AdminCommand> = new Set(['limpar']);

const COMMAND_TO_NEW_STATE: Record<
  Extract<AdminCommand, 'pausar' | 'retomar' | 'transferir'>,
  'PAUSED' | 'AUTO' | 'HUMAN_TAKEOVER'
> = {
  pausar: 'PAUSED',
  retomar: 'AUTO',
  transferir: 'HUMAN_TAKEOVER',
};

const COMMAND_TO_RESPONSE: Record<
  Extract<AdminCommand, 'pausar' | 'retomar' | 'transferir'>,
  string
> = {
  pausar: '✅ Agente pausado. Use /retomar para reativar.',
  retomar: '✅ Agente reativado.',
  transferir:
    '✅ Atendimento agora é humano. Use /retomar para devolver ao agente.',
};

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 8 — helpers para `/assumi` e `/devolver`
// ─────────────────────────────────────────────────────────────────────────────

const UUID_FULL_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PREFIX_REGEX = /^[0-9a-f]{8,}$/i;

const MIN_PREFIX_LEN = 8;
const MAX_RESOLVE_RESULTS = 6; // 5 listáveis + 1 detector de "muitos"

interface LeadResolveRow {
  id: string;
  contact_id: string;
  is_human_active: boolean | null;
  handoff_assumed_at: Date | string | null;
  contact_name: string | null;
  contact_phone: string | null;
  [key: string]: unknown;
}

type LeadResolveResult =
  | { kind: 'invalid_format' }
  | { kind: 'not_found'; queried: string }
  | { kind: 'ambiguous'; matches: LeadResolveRow[]; queried: string }
  | { kind: 'ok'; lead: LeadResolveRow };

/**
 * Resolve um lead a partir de um input do admin (UUID completo OU prefix de
 * 8+ chars hex). Faz 1 SELECT em `leads` JOIN `contacts` para retornar dados
 * úteis para mensagem de confirmação E para detectar ambiguidade.
 *
 * - `invalid_format`: input não bate UUID nem prefix hex válido.
 * - `not_found`: 0 matches.
 * - `ambiguous`: 2+ matches (devolve até 5 para listar).
 * - `ok`: 1 match.
 */
async function resolveLeadIdByPrefix(
  rawInput: string,
): Promise<LeadResolveResult> {
  const input = rawInput.trim().toLowerCase();

  if (!input) {
    return { kind: 'invalid_format' };
  }

  // UUID completo: comparação exata (sem LIKE — usa o índice PK).
  if (UUID_FULL_REGEX.test(input)) {
    const rows = await db.execute<LeadResolveRow>(sql`
      SELECT l.id::text                  AS id,
             l.contact_id::text          AS contact_id,
             COALESCE(l.is_human_active, false) AS is_human_active,
             l.handoff_assumed_at        AS handoff_assumed_at,
             c.name                      AS contact_name,
             c.phone                     AS contact_phone
        FROM leads l
        JOIN contacts c ON c.id = l.contact_id
       WHERE l.id = ${input}::uuid
       LIMIT 1
    `);
    const arr = Array.from(rows) as LeadResolveRow[];
    if (arr.length === 0) {
      return { kind: 'not_found', queried: input };
    }
    return { kind: 'ok', lead: arr[0] };
  }

  // Prefix hex >= 8 chars: LIKE em id::text (custo baixo — UUID indexado;
  // fallback seq scan em poucas dezenas de leads no MVP).
  if (UUID_PREFIX_REGEX.test(input) && input.length >= MIN_PREFIX_LEN) {
    const likePattern = `${input}%`;
    const rows = await db.execute<LeadResolveRow>(sql`
      SELECT l.id::text                  AS id,
             l.contact_id::text          AS contact_id,
             COALESCE(l.is_human_active, false) AS is_human_active,
             l.handoff_assumed_at        AS handoff_assumed_at,
             c.name                      AS contact_name,
             c.phone                     AS contact_phone
        FROM leads l
        JOIN contacts c ON c.id = l.contact_id
       WHERE l.id::text LIKE ${likePattern}
       ORDER BY l.created_at DESC
       LIMIT ${MAX_RESOLVE_RESULTS}
    `);
    const arr = Array.from(rows) as LeadResolveRow[];
    if (arr.length === 0) {
      return { kind: 'not_found', queried: input };
    }
    if (arr.length === 1) {
      return { kind: 'ok', lead: arr[0] };
    }
    return { kind: 'ambiguous', matches: arr, queried: input };
  }

  return { kind: 'invalid_format' };
}

/** Formata Date → 'DD/MM/YYYY HH:MM' simples (sem timezone — pattern do
 *  composer.ts). Retorna '—' para null/undefined. */
function formatTimestampBR(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

/** Prefix curto (8 chars) para exibir em mensagens — UUID completo é ruim de
 *  ler/digitar. */
function shortenLeadId(leadId: string): string {
  return leadId.slice(0, 8);
}

/** Renderiza mensagem de ambiguidade quando o prefix bate em 2+ leads. */
function formatAmbiguousMessage(
  queried: string,
  matches: LeadResolveRow[],
): string {
  const listed = matches.slice(0, 5);
  const lines = listed.map((m) => {
    const sid = shortenLeadId(m.id);
    const name = m.contact_name ?? '(sem nome)';
    const phone = m.contact_phone ?? '—';
    return `• ${sid} — ${name} (${phone})`;
  });
  const more = matches.length > 5 ? '\n• … e mais' : '';
  return `⚠️ Prefixo ambíguo "${queried}" — ${matches.length} leads encontrados:\n${lines.join('\n')}${more}\n\nUse mais caracteres do ID para desambiguar.`;
}

// ─────────────────────────────────────────────────────────────────────────────

export const adminRouter: Hook = {
  name: 'admin-router',
  phase: 'BEFORE_REQUEST',

  async run(ctx: HarnessContext): Promise<HookResult> {
    const text = ctx.message.text;
    if (!text) {
      return {};
    }

    const match = ADMIN_REGEX.exec(text);
    if (!match) {
      return {};
    }

    const command = match[1].toLowerCase() as AdminCommand;
    const argsRaw = (match[2] ?? '').trim();

    // FIXME(testing): comandos em `PUBLIC_COMMANDS` ignoram a whitelist
    // durante o hardening local. Reverter antes de produção.
    if (!PUBLIC_COMMANDS.has(command)) {
      const params = (ctx.config?.hookParams ?? {}) as HookParamsShape;
      const adminPhones = params.admin_phones ?? [];

      if (!adminPhones.includes(ctx.contact.phone)) {
        // Comando bate o regex mas o phone NÃO é admin — segue o pipeline
        // normal (a IA pode tratar a mensagem como qualquer outra). Não emite
        // trace para não vazar tentativa de impersonation no log; o sender
        // passa adiante.
        return {};
      }
    }

    // Lê o estado atual do contato (precisamos do prev_state para o trace).
    const prevRows = await db.execute<{ ai_state: string }>(sql`
      SELECT ai_state FROM contacts WHERE id = ${ctx.contact.id} LIMIT 1
    `);
    const prevArr = Array.from(prevRows) as Array<{ ai_state: string }>;
    const prevState = prevArr[0]?.ai_state ?? 'AUTO';

    if (command === 'limpar') {
      // FIXME(testing): comando público durante o hardening local. Marca todas
      // as `messages` do contato como redacted (`redacted_at = now()`) — o L1
      // composer filtra `WHERE redacted_at IS NULL`, então o LLM passa a ver
      // o histórico zerado a partir do próximo turno. Não toca em `leads`,
      // `contact_facts`, `contacts.name`, nem `is_human_active`. Auditoria
      // preservada (rows continuam no banco).
      const updateRows = await db.execute<{ id: string }>(sql`
        UPDATE messages
           SET redacted_at = now()
         WHERE contact_id = ${ctx.contact.id}
           AND redacted_at IS NULL
        RETURNING id
      `);
      const redactedCount = Array.from(updateRows).length;

      ctx.eventBus.emit(
        'admin_command_executed',
        {
          command,
          by_phone: ctx.contact.phone,
          contact_id: ctx.contact.id,
          redacted_count: redactedCount,
        },
        'info',
      );

      return {
        shortCircuit: true,
        response: `🧹 Histórico limpo (${redactedCount} mensagens). Próximo turno começa do zero.`,
      };
    }

    if (command === 'status') {
      // Sem UPDATE; só responde o estado atual.
      // Lê também o is_human_active do lead ativo (se houver).
      let isHumanActive = false;
      if (ctx.lead?.id) {
        const leadRows = await db.execute<{ is_human_active: boolean }>(sql`
          SELECT is_human_active FROM leads WHERE id = ${ctx.lead.id} LIMIT 1
        `);
        const leadArr = Array.from(leadRows) as Array<{
          is_human_active: boolean;
        }>;
        isHumanActive = leadArr[0]?.is_human_active ?? false;
      }
      const response = `Estado atual: ai_state=${prevState}, is_human_active=${isHumanActive}.`;

      ctx.eventBus.emit(
        'admin_command_executed',
        {
          command,
          by_phone: ctx.contact.phone,
          contact_id: ctx.contact.id,
          prev_state: prevState,
        },
        'info',
      );
      return { shortCircuit: true, response };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Bloco 8 — `/assumi <lead_id>` e `/devolver <lead_id>`
    // ─────────────────────────────────────────────────────────────────────

    if (command === 'assumi' || command === 'devolver') {
      // (1) validação de uso: precisa do lead_id.
      if (!argsRaw) {
        return {
          shortCircuit: true,
          response: `Uso: /${command} <lead_id>\n\nExemplo: /${command} a1b2c3d4 (8+ caracteres do ID).`,
        };
      }

      // (2) resolve o lead (UUID completo OU prefix 8+ hex).
      const resolved = await resolveLeadIdByPrefix(argsRaw);

      if (resolved.kind === 'invalid_format') {
        return {
          shortCircuit: true,
          response: `❌ Formato inválido: "${argsRaw}".\n\nUse o UUID completo ou um prefixo com 8+ caracteres (a-f, 0-9).`,
        };
      }
      if (resolved.kind === 'not_found') {
        return {
          shortCircuit: true,
          response: `❌ Lead não encontrado para "${resolved.queried}". Verifique o ID.`,
        };
      }
      if (resolved.kind === 'ambiguous') {
        return {
          shortCircuit: true,
          response: formatAmbiguousMessage(resolved.queried, resolved.matches),
        };
      }

      // resolved.kind === 'ok'
      const lead = resolved.lead;
      const sid = shortenLeadId(lead.id);
      const prevAssumedAt = lead.handoff_assumed_at;
      const prevIsHumanActive = lead.is_human_active === true;

      if (command === 'assumi') {
        // (3a) info: lead não está em handoff (is_human_active=false)
        if (!prevIsHumanActive) {
          ctx.eventBus.emit(
            'admin_command_executed',
            {
              command,
              by_phone: ctx.contact.phone,
              contact_id: ctx.contact.id,
              lead_id: lead.id,
              outcome: 'not_in_handoff',
            },
            'info',
          );
          return {
            shortCircuit: true,
            response: `⚠️ Lead ${sid} não está em handoff. A IA segue respondendo normalmente neste lead.\n\nSe deseja transferir manualmente, peça ao operador para usar a tool de transferência ou aguarde a IA classificar como HOT.`,
          };
        }

        // (3b) idempotente: já estava assumido — não sobrescreve timestamp.
        if (prevAssumedAt !== null && prevAssumedAt !== undefined) {
          const prevTs = formatTimestampBR(prevAssumedAt);
          ctx.eventBus.emit(
            'admin_command_executed',
            {
              command,
              by_phone: ctx.contact.phone,
              contact_id: ctx.contact.id,
              lead_id: lead.id,
              outcome: 'already_assumed',
              prev_assumed_at:
                prevAssumedAt instanceof Date
                  ? prevAssumedAt.toISOString()
                  : String(prevAssumedAt),
            },
            'info',
          );
          return {
            shortCircuit: true,
            response: `ℹ️ Lead ${sid} já estava assumido em ${prevTs}. Nada mudou (idempotente).\n\nUse /devolver ${sid} para devolver à IA.`,
          };
        }

        // (3c) caminho feliz: SET handoff_assumed_at = NOW().
        // UPDATE com guard `WHERE handoff_assumed_at IS NULL` por segurança
        // adicional — protege contra race com webhook detection (Bloco 9).
        const updRows = await db.execute<{
          handoff_assumed_at: Date | string;
        }>(sql`
          UPDATE leads
             SET handoff_assumed_at = now(),
                 updated_at         = now()
           WHERE id = ${lead.id}::uuid
             AND handoff_assumed_at IS NULL
          RETURNING handoff_assumed_at
        `);
        const updArr = Array.from(updRows) as Array<{
          handoff_assumed_at: Date | string;
        }>;

        if (updArr.length === 0) {
          // Race: alguém setou entre o SELECT e o UPDATE. Trata como
          // already_assumed sem refazer query (mensagem suficientemente
          // genérica).
          ctx.eventBus.emit(
            'admin_command_executed',
            {
              command,
              by_phone: ctx.contact.phone,
              contact_id: ctx.contact.id,
              lead_id: lead.id,
              outcome: 'race_already_assumed',
            },
            'info',
          );
          return {
            shortCircuit: true,
            response: `ℹ️ Lead ${sid} já havia sido assumido por outro caminho (race). Nada a fazer.\n\nUse /devolver ${sid} para devolver à IA.`,
          };
        }

        const newTs = formatTimestampBR(updArr[0].handoff_assumed_at);

        ctx.eventBus.emit(
          'handoff_assumed_via_admin',
          {
            lead_id: lead.id,
            lead_id_prefix: sid,
            admin_phone: ctx.contact.phone,
            contact_id: lead.contact_id,
            prev_assumed_at: null,
            prev_is_human_active: prevIsHumanActive,
          },
          'info',
        );
        ctx.eventBus.emit(
          'admin_command_executed',
          {
            command,
            by_phone: ctx.contact.phone,
            contact_id: ctx.contact.id,
            lead_id: lead.id,
            outcome: 'assumed',
          },
          'info',
        );

        return {
          shortCircuit: true,
          response: `✅ Lead ${sid} assumido por humano em ${newTs}. A IA não responderá mais para este lead.\n\nUse /devolver ${sid} para reverter.`,
        };
      }

      // command === 'devolver'
      // /devolver SEMPRE reseta para FREE: is_human_active=false +
      // handoff_assumed_at=NULL. Idempotente quando já estava livre.

      if (!prevIsHumanActive && prevAssumedAt === null) {
        ctx.eventBus.emit(
          'admin_command_executed',
          {
            command,
            by_phone: ctx.contact.phone,
            contact_id: ctx.contact.id,
            lead_id: lead.id,
            outcome: 'already_free',
          },
          'info',
        );
        return {
          shortCircuit: true,
          response: `ℹ️ Lead ${sid} já estava no modo normal (IA respondendo). Nada mudou.`,
        };
      }

      await db.execute(sql`
        UPDATE leads
           SET is_human_active     = false,
               handoff_assumed_at  = NULL,
               updated_at          = now()
         WHERE id = ${lead.id}::uuid
      `);

      ctx.eventBus.emit(
        'handoff_returned_via_admin',
        {
          lead_id: lead.id,
          lead_id_prefix: sid,
          admin_phone: ctx.contact.phone,
          contact_id: lead.contact_id,
          prev_assumed_at:
            prevAssumedAt instanceof Date
              ? prevAssumedAt.toISOString()
              : prevAssumedAt === null
                ? null
                : String(prevAssumedAt),
          prev_is_human_active: prevIsHumanActive,
        },
        'info',
      );
      ctx.eventBus.emit(
        'admin_command_executed',
        {
          command,
          by_phone: ctx.contact.phone,
          contact_id: ctx.contact.id,
          lead_id: lead.id,
          outcome: 'returned',
        },
        'info',
      );

      return {
        shortCircuit: true,
        response: `✅ Lead ${sid} devolvido à IA. A IA voltou a responder normalmente neste lead.\n\nUse /assumi ${sid} para reassumir.`,
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // /reativar-followup <phone> (feature follow-up-pendente, Bloco 6)
    // ─────────────────────────────────────────────────────────────────────

    if (command === 'reativar-followup') {
      // (1) validação de uso.
      if (!argsRaw) {
        return {
          shortCircuit: true,
          response:
            `Uso: /reativar-followup <phone>\n\n` +
            `Phone no formato Zapster (sem '+', ex: 5519997124472).`,
        };
      }
      const phone = argsRaw.trim();
      if (!PHONE_REGEX.test(phone)) {
        return {
          shortCircuit: true,
          response: `❌ Formato inválido: "${phone}". Use dígitos contínuos sem '+' (ex: 5519997124472).`,
        };
      }

      // (2) resolve contato + lead OPEN mais recente.
      const resolved = await resolveContactByPhoneForReactivation(phone);
      if (!resolved) {
        ctx.eventBus.emit(
          'admin_command_executed',
          {
            command,
            by_phone: ctx.contact.phone,
            target_phone: phone,
            outcome: 'contact_not_found',
          },
          'info',
        );
        return {
          shortCircuit: true,
          response: `❌ Contato não encontrado para o número ${phone}.`,
        };
      }

      if (!resolved.lead_id) {
        ctx.eventBus.emit(
          'admin_command_executed',
          {
            command,
            by_phone: ctx.contact.phone,
            target_phone: phone,
            target_contact_id: resolved.contact_id,
            outcome: 'no_open_lead',
          },
          'info',
        );
        return {
          shortCircuit: true,
          response: `⚠️ Contato ${resolved.contact_name ?? phone} não tem lead aberto. Nada a reativar.`,
        };
      }

      // (3) idempotente: já está habilitado.
      if (resolved.lead_follow_up_disabled === false) {
        ctx.eventBus.emit(
          'admin_command_executed',
          {
            command,
            by_phone: ctx.contact.phone,
            target_phone: phone,
            target_contact_id: resolved.contact_id,
            target_lead_id: resolved.lead_id,
            outcome: 'already_enabled',
          },
          'info',
        );
        return {
          shortCircuit: true,
          response: `ℹ️ Follow-ups de ${resolved.contact_name ?? phone} já estavam ativos. Nada mudou.`,
        };
      }

      // (4) UPDATE leads.follow_up_disabled = false (UMA lead — a aberta mais recente).
      await db.execute(sql`
        UPDATE leads
           SET follow_up_disabled = false,
               updated_at         = now()
         WHERE id = ${resolved.lead_id}::uuid
      `);

      ctx.eventBus.emit(
        'follow_up_reactivated',
        {
          phone,
          lead_id: resolved.lead_id,
          contact_id: resolved.contact_id,
          by_admin_phone: ctx.contact.phone,
        },
        'info',
      );
      ctx.eventBus.emit(
        'admin_command_executed',
        {
          command,
          by_phone: ctx.contact.phone,
          target_phone: phone,
          target_contact_id: resolved.contact_id,
          target_lead_id: resolved.lead_id,
          outcome: 'reactivated',
        },
        'info',
      );

      return {
        shortCircuit: true,
        response:
          `✅ Follow-ups reativados para ${resolved.contact_name ?? phone} (${phone}). ` +
          `Próximo ciclo do cron pode enviar nova tentativa quando o lead estiver dentro das regras.`,
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // pausar / retomar / transferir — comportamento original
    // ─────────────────────────────────────────────────────────────────────

    const newState = COMMAND_TO_NEW_STATE[command];
    await db.execute(sql`
      UPDATE contacts SET ai_state = ${newState} WHERE id = ${ctx.contact.id}
    `);

    ctx.eventBus.emit(
      'admin_command_executed',
      {
        command,
        by_phone: ctx.contact.phone,
        contact_id: ctx.contact.id,
        prev_state: prevState,
        new_state: newState,
      },
      'info',
    );

    return {
      shortCircuit: true,
      response: COMMAND_TO_RESPONSE[command],
    };
  },
};
