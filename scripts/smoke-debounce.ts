// scripts/smoke-debounce.ts
//
// Smoke da lógica pura da Feature A (1.1): resolução do bucket_ms e do TTL
// derivado da LIST Redis. Não toca Redis/DB — testa só os helpers puros.
//
// Rodar: npx tsx scripts/smoke-debounce.ts

import {
  resolveBucketMs,
  deriveBucketTtlMs,
  DEFAULT_BUCKET_MS,
  MIN_BUCKET_TTL_MS,
} from '../src/queue/debouncer';

let pass = 0;
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} — esperado ${String(want)}, obtido ${String(got)}`);
  }
}

console.log('Feature A — resolveBucketMs');
eq('default quando ausente', resolveBucketMs(undefined), DEFAULT_BUCKET_MS);
eq('default quando null', resolveBucketMs(null), DEFAULT_BUCKET_MS);
eq('valor válido 1500', resolveBucketMs(1500), 1500);
eq('valor válido 4000', resolveBucketMs(4000), 4000);
eq('zero → default', resolveBucketMs(0), DEFAULT_BUCKET_MS);
eq('negativo → default', resolveBucketMs(-5), DEFAULT_BUCKET_MS);
eq('string → default', resolveBucketMs('2500'), DEFAULT_BUCKET_MS);
eq('NaN → default', resolveBucketMs(Number.NaN), DEFAULT_BUCKET_MS);

console.log('Feature A — deriveBucketTtlMs (>= 4x bucket, piso 10s)');
eq('bucket 2500 → piso 10000', deriveBucketTtlMs(2500), 10_000);
eq('bucket 1000 → piso 10000', deriveBucketTtlMs(1000), MIN_BUCKET_TTL_MS);
eq('bucket 3000 → 12000', deriveBucketTtlMs(3000), 12_000);
eq('bucket 5000 → 20000', deriveBucketTtlMs(5000), 20_000);
eq('bucket 2500 == 4x', deriveBucketTtlMs(2500), 4 * 2500);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
