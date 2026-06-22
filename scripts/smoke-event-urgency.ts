// scripts/smoke-event-urgency.ts
//
// Smoke da lógica pura da Feature 1.6 (ADR 0001): proximidade derivada de
// event_date. Não toca DB/relógio — o "hoje" é passado explicitamente.
//
// Rodar: npx tsx scripts/smoke-event-urgency.ts

import {
  resolveUrgencyThresholds,
  daysUntil,
  deriveEventUrgency,
  DEFAULT_URGENCY_THRESHOLDS,
} from '../src/utils/event-urgency';

let pass = 0;
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} — esperado ${w}, obtido ${g}`);
  }
}

const T = DEFAULT_URGENCY_THRESHOLDS; // {7,30}
const HOJE = '2026-06-22';

console.log('Feature 1.6 — resolveUrgencyThresholds');
eq('default quando ausente', resolveUrgencyThresholds(undefined), T);
eq('custom 30/90', resolveUrgencyThresholds({ imediato: 30, proximo: 90 }), { imediato: 30, proximo: 90 });
eq('campo inválido cai no default', resolveUrgencyThresholds({ imediato: 'x', proximo: 0 }), T);

console.log('Feature 1.6 — daysUntil');
eq('9 dias', daysUntil('2026-07-01', HOJE), 9);
eq('mesmo dia = 0', daysUntil(HOJE, HOJE), 0);
eq('com horário (slice)', daysUntil('2026-07-01T13:00:00.000Z', HOJE), 9);
eq('inválido → null', daysUntil('xx', HOJE), null);

console.log('Feature 1.6 — deriveEventUrgency (default 7/30)');
eq('sem data → null', deriveEventUrgency(null, HOJE, T), null);
eq('hoje (0d) → IMEDIATO', deriveEventUrgency('2026-06-22', HOJE, T), 'IMEDIATO');
eq('3 dias → IMEDIATO', deriveEventUrgency('2026-06-25', HOJE, T), 'IMEDIATO');
eq('exatamente 7 → IMEDIATO', deriveEventUrgency('2026-06-29', HOJE, T), 'IMEDIATO');
eq('8 dias → PROXIMO', deriveEventUrgency('2026-06-30', HOJE, T), 'PROXIMO');
eq('exatamente 30 → PROXIMO', deriveEventUrgency('2026-07-22', HOJE, T), 'PROXIMO');
eq('31 dias → PLANEJADO', deriveEventUrgency('2026-07-23', HOJE, T), 'PLANEJADO');
eq('71 dias → PLANEJADO', deriveEventUrgency('2026-09-01', HOJE, T), 'PLANEJADO');
eq('data passada → null', deriveEventUrgency('2026-06-01', HOJE, T), null);

console.log('Feature 1.6 — thresholds custom (30/90)');
eq('20 dias com 30/90 → IMEDIATO', deriveEventUrgency('2026-07-12', HOJE, { imediato: 30, proximo: 90 }), 'IMEDIATO');

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
