// scripts/smoke-bloco11.ts
//
// Bloco 11 — Smoke programático MÍNIMO (modo econômico, 1 cenário).
//
//   Smoke 1 — cache hit + invalidação por TTL.
//     1. invalidate() — começa do zero.
//     2. findActiveByKey('angelina') 1ª vez → 1 SELECT no banco (spy +1).
//        Esperado: null (v1/v2 ambas com is_active=false na produção).
//     3. Inspeção: _internals.cache.get('angelina') existe + value=null + expiresAt > now.
//     4. findActiveByKey('angelina') 99× → 0 SELECTs adicionais (cache hit).
//     5. Forçar expiração: cache.get('angelina').expiresAt = Date.now() - 1.
//     6. findActiveByKey('angelina') → +1 SELECT (cache miss novamente).
//     7. invalidate('angelina') no cleanup.
//
// Spy: monkey-patch `db.select` global do `db/client` para contar quantas
// vezes é invocado neste teste. Restaurado no finally.
//
// SQL antes/depois (modo econômico): mesma query, esperar idêntico
// (v1=false, v2=false). Sem mutação de schema/dados.

import 'dotenv/config';

// Garante TTL longo o suficiente para os 99 hits não expirarem (default 30s).
// Não setamos AGENT_CONFIGS_CACHE_TTL_MS — usamos o padrão (30s) e forçamos
// expiração manualmente via _internals.cache.

import { db, closeDb } from '../src/db/client';
import {
  findActiveByKey,
  invalidate,
  _internals,
} from '../src/config/agent-configs';

interface SmokeResult {
  name: string;
  pass: boolean;
  details: Record<string, unknown>;
}

const results: SmokeResult[] = [];

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spy em db.select — conta invocações.
// ─────────────────────────────────────────────────────────────────────────────

const originalSelect = db.select.bind(db);
let selectCallCount = 0;

function installSpy(): void {
  selectCallCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).select = (...args: unknown[]) => {
    selectCallCount += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalSelect as any)(...args);
  };
}

function uninstallSpy(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).select = originalSelect;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke 1
// ─────────────────────────────────────────────────────────────────────────────

async function smoke1(): Promise<void> {
  console.log('\n=== Smoke 1 — cache hit + invalidação por TTL ===');

  invalidate(); // zera cache
  installSpy();

  // 1ª chamada — cache miss esperado.
  const r1 = await findActiveByKey('angelina');
  const callsAfterFirst = selectCallCount;
  console.log(
    `  [1] 1ª call: r1=${r1 === null ? 'null' : r1.id} | selectCalls=${callsAfterFirst}`,
  );
  assert(callsAfterFirst === 1, '1ª call deveria ter feito 1 SELECT (cache miss)');

  // Cache deve ter sido populado.
  const cached = _internals.cache.get('angelina');
  assert(cached !== undefined, 'cache.get(angelina) deveria existir após miss');
  assert(cached!.value === r1, 'cache.value deveria === r1');
  assert(cached!.expiresAt > Date.now(), 'cache.expiresAt deveria ser futuro');
  console.log(
    `  [2] cache populado: value=${cached!.value === null ? 'null' : 'row'} expiresAt=${cached!.expiresAt - Date.now()}ms futuro`,
  );

  // 99 calls extras — todas devem ser cache hit (selectCount inalterado).
  for (let i = 0; i < 99; i++) {
    const ri = await findActiveByKey('angelina');
    assert(ri === r1, `call #${i + 2} retornou valor diferente`);
  }
  const callsAfter100 = selectCallCount;
  console.log(
    `  [3] +99 calls: selectCalls=${callsAfter100} (esperado: ${callsAfterFirst} — todas cache hit)`,
  );
  assert(
    callsAfter100 === callsAfterFirst,
    `99 calls não deveriam ter ido ao banco; selectCount foi de ${callsAfterFirst} para ${callsAfter100}`,
  );

  // Força expiração — simula passagem de TTL.
  const entry = _internals.cache.get('angelina')!;
  entry.expiresAt = Date.now() - 1;
  console.log('  [4] expiração forçada: entry.expiresAt = past');

  // Próxima call → cache miss → +1 SELECT.
  const r2 = await findActiveByKey('angelina');
  const callsAfterExpired = selectCallCount;
  console.log(
    `  [5] post-expiry call: r2=${r2 === null ? 'null' : r2.id} | selectCalls=${callsAfterExpired} (esperado ${callsAfterFirst + 1})`,
  );
  assert(
    callsAfterExpired === callsAfterFirst + 1,
    `post-expiry deveria ter feito +1 SELECT; foi de ${callsAfterFirst} para ${callsAfterExpired}`,
  );

  // Valor deve ser igual (banco não mudou).
  assert(
    (r1 === null && r2 === null) || (r1 !== null && r2 !== null && r1.id === r2.id),
    'r1 e r2 deveriam representar a mesma row (ou ambos null)',
  );

  results.push({
    name: 'cache hit + TTL invalidação',
    pass: true,
    details: {
      callsAfterFirst,
      callsAfter100,
      callsAfterExpired,
      r1IsNull: r1 === null,
      r2IsNull: r2 === null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    await smoke1();
  } catch (err) {
    console.error('\n!! SMOKE FAILED:', err);
    exitCode = 1;
    results.push({
      name: 'cache hit + TTL invalidação',
      pass: false,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    uninstallSpy();
    invalidate('angelina');
    console.log('\n=== Cleanup ===');
    console.log('  spy uninstalled, cache.angelina invalidado');

    console.log('\n=== Resultados ===');
    for (const r of results) {
      console.log(
        `  ${r.pass ? 'PASS' : 'FAIL'} — ${r.name}: ${JSON.stringify(r.details)}`,
      );
    }

    await closeDb();
  }
  process.exit(exitCode);
}

main();
