// src/templates/follow-up-message.ts
//
// Bloco 2 — Tasks #13 + #13b da feature `follow-up-pendente`.
//
// Renderer dos 5 templates por categoria (D7') + renderer da msg de escalação
// ao support_whatsapp (RF5).
//
// **Decisão D7'** — Prefixo `Oi {{nome}}! ` é AUTOMÁTICO no renderer.
// Operador edita apenas o texto da categoria em
// `agent_configs.hook_params.follow_up.templates`; o renderer concatena
// `Oi ${nome}! ` + `templates[categoria]` na hora.
//
// **Variáveis interpoladas:**
//   - `tipo_evento`, `data`, `convidados`, `orcamento`: texto literal,
//     sem variáveis (são fixos no v1 D7').
//   - `generico`: interpola `{{pergunta_extraida}}` via `interpolateTemplate`.
//   - `escalation_support_template`: interpola 8 vars (nome, whatsapp,
//     evento, data, convidados, follow_up_1_time, follow_up_2_time,
//     ultimas_5_msgs) via `interpolateTemplate`.

import type { FollowUpCategoria, FollowUpTemplates } from '../config/types';
import { interpolateTemplate } from '../utils/template';

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up ao cliente (D7')
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderFollowUpMessageInput {
  /** Primeiro nome (ou nome completo) do contato — vai em `Oi {nome}!`. */
  contactName: string;
  /** Categoria detectada pelo pipeline em `utils/follow-up-question.ts` (D11'). */
  categoria: FollowUpCategoria;
  /** Pergunta extraída — obrigatória SE categoria === 'generico'. */
  perguntaExtraida?: string;
  /** 5 templates literais lidos de `hook_params.follow_up.templates`. */
  templates: FollowUpTemplates;
}

/**
 * Monta a mensagem final de follow-up: `Oi {nome}! ` + texto da categoria.
 *
 * - `generico`: interpola `{{pergunta_extraida}}` no texto antes de prefixar.
 * - Demais categorias: usa o texto literal sem interpolação.
 *
 * Função pura — sem I/O.
 */
export function renderFollowUpMessage(input: RenderFollowUpMessageInput): string {
  const { contactName, categoria, perguntaExtraida, templates } = input;
  const prefixo = `Oi ${contactName.trim()}! `;

  if (categoria === 'generico') {
    const interpolado = interpolateTemplate(templates.generico, {
      pergunta_extraida: perguntaExtraida ?? '',
    });
    return prefixo + interpolado;
  }

  return prefixo + templates[categoria];
}

// ─────────────────────────────────────────────────────────────────────────────
// Escalação ao support_whatsapp (RF5 — Bloco 5)
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderEscalationMessageInput {
  template: string;
  vars: {
    nome: string;
    whatsapp: string;
    evento: string;
    /** ISO YYYY-MM-DD; auto-conv → DD/MM/YYYY pelo `interpolateTemplate`. */
    data: string | null;
    convidados: string;
    /** Timestamp formatado já como BR (ex: "12/05 14:30"). */
    follow_up_1_time: string;
    follow_up_2_time: string;
    /** Bloco formatado pelas últimas 5 msgs (Cliente: ... / Angelina: ...). */
    ultimas_5_msgs: string;
  };
}

/**
 * Renderiza o template de escalação ao support_whatsapp.
 * Função pura — sem I/O.
 */
export function renderEscalationMessage(
  input: RenderEscalationMessageInput,
): string {
  return interpolateTemplate(input.template, input.vars);
}
