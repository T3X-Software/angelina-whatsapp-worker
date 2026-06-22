// scripts/smoke-notification-targets.ts
//
// Smoke da lógica pura da Feature C (3.1): resolução dos alvos da notificação
// de handoff. Não toca DB/harness — testa só `resolveNotificationTargets`.
//
// Rodar: npx tsx scripts/smoke-notification-targets.ts

import { resolveNotificationTargets } from '../src/utils/notification-targets';

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

console.log('Feature C — resolveNotificationTargets');

// 1. Lista com 2 números → usa a lista, source = notification_targets.
eq(
  'lista com 2 numeros',
  resolveNotificationTargets(['5519111111111', '5519222222222'], '5519999999999'),
  { targets: ['5519111111111', '5519222222222'], source: 'notification_targets' },
);

// 2. Trim + dedup (mesmo numero repetido / com espaços).
eq(
  'trim + dedup',
  resolveNotificationTargets(['  5519111111111 ', '5519111111111', ' 5519222222222'], ''),
  { targets: ['5519111111111', '5519222222222'], source: 'notification_targets' },
);

// 3. Lista vazia → fallback para support_whatsapp.
eq(
  'vazio -> fallback support_whatsapp',
  resolveNotificationTargets([], '5519974131955'),
  { targets: ['5519974131955'], source: 'support_whatsapp_fallback' },
);

// 4. Ausente (undefined) → fallback.
eq(
  'undefined -> fallback',
  resolveNotificationTargets(undefined, '5519974131955'),
  { targets: ['5519974131955'], source: 'support_whatsapp_fallback' },
);

// 5. Ambos vazios → none.
eq('ambos vazios -> none', resolveNotificationTargets([], ''), {
  targets: [],
  source: 'none',
});

// 6. notification_targets presente IGNORA support_whatsapp (sem fallback).
eq(
  'lista presente ignora support',
  resolveNotificationTargets(['5519111111111'], '5519974131955'),
  { targets: ['5519111111111'], source: 'notification_targets' },
);

// 7. Defensivo: JSONB malformado (itens não-string) são descartados.
eq(
  'descarta itens nao-string',
  resolveNotificationTargets(['5519111111111', 42, null, '', '   '], '5519974131955'),
  { targets: ['5519111111111'], source: 'notification_targets' },
);

// 8. Defensivo: notification_targets não-array → fallback.
eq(
  'nao-array -> fallback',
  resolveNotificationTargets('5519111111111', '5519974131955'),
  { targets: ['5519974131955'], source: 'support_whatsapp_fallback' },
);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
