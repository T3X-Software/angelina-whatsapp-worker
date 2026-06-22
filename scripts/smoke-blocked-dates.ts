// scripts/smoke-blocked-dates.ts
//
// Smoke da lógica pura da Feature 1.11 (check_blocked_dates): resolução do
// intervalo e mapeamento das linhas. Não toca DB — testa só os helpers.
//
// Rodar: npx tsx scripts/smoke-blocked-dates.ts

import {
  resolveBlockedDatesRange,
  toHHMM,
  mapBlockedRow,
} from '../src/utils/blocked-dates';

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
    console.error(`  ✗ ${name}\n      esperado: ${w}\n      obtido:   ${g}`);
  }
}

console.log('Feature 1.11 — resolveBlockedDatesRange');
eq('date único', resolveBlockedDatesRange({ date: '2026-06-17' }), {
  start: '2026-06-17',
  end: '2026-06-17',
});
eq('intervalo', resolveBlockedDatesRange({ start_date: '2026-06-01', end_date: '2026-06-30' }), {
  start: '2026-06-01',
  end: '2026-06-30',
});
eq('start sem end → dia único', resolveBlockedDatesRange({ start_date: '2026-07-10' }), {
  start: '2026-07-10',
  end: '2026-07-10',
});
eq('intervalo invertido → normaliza', resolveBlockedDatesRange({ start_date: '2026-06-30', end_date: '2026-06-01' }), {
  start: '2026-06-01',
  end: '2026-06-30',
});
eq('vazio → erro', resolveBlockedDatesRange({}), {
  error: 'informe `date` (dia único) ou `start_date` (intervalo)',
});

console.log('Feature 1.11 — toHHMM');
eq('16:09:00 → 16:09', toHHMM('16:09:00'), '16:09');
eq('null → null', toHHMM(null), null);
eq('undefined → null', toHHMM(undefined), null);

console.log('Feature 1.11 — mapBlockedRow');
eq(
  'faixa de horário',
  mapBlockedRow({ date: '2026-06-17', start_time: '16:09:00', end_time: '22:09:00', reason: 'EVENTO PA' }),
  { date: '2026-06-17', full_day: false, start_time: '16:09', end_time: '22:09', reason: 'EVENTO PA' },
);
eq(
  'dia inteiro (start null)',
  mapBlockedRow({ date: '2026-12-25', start_time: null, end_time: null, reason: 'Natal' }),
  { date: '2026-12-25', full_day: true, start_time: null, end_time: null, reason: 'Natal' },
);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
