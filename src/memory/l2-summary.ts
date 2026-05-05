// src/memory/l2-summary.ts
//
// Bloco 10 — Task 52.
//
// L2 = sumário do contato — texto estruturado em PT-BR montado a partir
// dos `contact_facts` ATIVOS (`superseded_by IS NULL`) com `confidence ≥ 0.7`
// e ainda não expirados.
//
// Concepts referenciados:
//   - `append-only-facts`: filtro `superseded_by IS NULL` + `expires_at` em
//     runtime (não pode estar no índice parcial — `now()` é STABLE).
//   - `memory-layers`: target ~200 tokens (~800 chars). Limite duro: 1000 chars
//     (truncamos se exceder; facts menos confidentes saem primeiro porque
//     ORDER BY confidence DESC).
//
// Mapeamento `fact_type` → label PT-BR:
//   - estagio        → "Estágio"
//   - dados, dado    → "Dados confirmados"
//   - preferencia    → "Preferências"
//   - restricao      → "Restrições"
//   - objecao        → "Objeções"
//   - (outros)       → o próprio fact_type (capitalizado).
//
// `fact_value` é jsonb (objeto). Render:
//   - Se tem chave única `value` → renderiza só o valor.
//   - Se tem múltiplas chaves    → "key:val, key:val" compacto.
//   - Se algum valor é objeto/array aninhado → JSON.stringify dele.

import { sql } from 'drizzle-orm';
import { db } from '../db/client';

const MAX_CHARS = 1000;

const FACT_TYPE_LABEL: Record<string, string> = {
  estagio: 'Estágio',
  dado: 'Dados confirmados',
  dados: 'Dados confirmados',
  preferencia: 'Preferências',
  preferencias: 'Preferências',
  restricao: 'Restrições',
  restricoes: 'Restrições',
  objecao: 'Objeções',
  objecoes: 'Objeções',
};

interface RawFactRow {
  fact_type: string;
  fact_value: Record<string, unknown> | null;
  confidence: string; // numeric vem como string em postgres-js
  [key: string]: unknown; // satisfaz constraint do db.execute<>
}

/**
 * Constrói o sumário L2 do contato. Retorna `''` (string vazia) se nenhum
 * fact qualifica — o composer omite a seção `## Sumário do contato` nesse caso.
 */
export async function buildSummary(contactId: string): Promise<string> {
  const result = await db.execute<RawFactRow>(sql`
    SELECT fact_type,
           fact_value,
           confidence::text AS confidence
      FROM contact_facts
     WHERE contact_id   = ${contactId}
       AND superseded_by IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND confidence >= 0.7
     ORDER BY confidence DESC, extracted_at DESC
  `);
  const rows = Array.from(result);
  if (rows.length === 0) return '';

  // Agrupa por fact_type (mantém ordem de inserção do agrupamento).
  const byType = new Map<string, string[]>();
  for (const row of rows) {
    const rendered = renderFactValue(row.fact_value);
    if (!rendered) continue;
    const list = byType.get(row.fact_type) ?? [];
    list.push(rendered);
    byType.set(row.fact_type, list);
  }

  // Monta linhas no formato "Label: v1, v2, v3".
  const lines: string[] = [];
  for (const [factType, values] of byType.entries()) {
    const label = FACT_TYPE_LABEL[factType] ?? capitalize(factType);
    lines.push(`${label}: ${values.join(', ')}`);
  }

  let out = lines.join('\n');
  // Truncamento defensivo (deve ser raríssimo — facts são curtos).
  // Como ORDER BY confidence DESC, ao fim da lista estão os menos confidentes,
  // que são os primeiros a sair quando truncamos.
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS - 3) + '...';
  }
  return out;
}

/**
 * Render compacto de um `fact_value` jsonb (sempre objeto pelo CHECK do schema).
 *
 *   {value: 'qualificacao'}             → "qualificacao"
 *   {tipo: 'chocolate'}                  → "chocolate" (chave única, render do value)
 *   {convidados: 200, evento: 'casamento'} → "convidados:200, evento:casamento"
 *   null / vazio                          → null (ignorado)
 */
function renderFactValue(value: Record<string, unknown> | null): string | null {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;

  if (entries.length === 1) {
    // Chave única: rendemos só o valor (o "label" já é o fact_type lá em cima).
    return scalarOrJson(entries[0][1]);
  }

  // Múltiplas chaves: compact key:val.
  return entries
    .map(([k, v]) => `${k}:${scalarOrJson(v)}`)
    .join(', ');
}

function scalarOrJson(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
