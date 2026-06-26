// scripts/smoke-healthz.ts
//
// Resiliência — valida o readiness check do /healthz (checkReadiness) com deps
// MOCKADAS (não toca DB/Redis reais). A rota mapeia ok→200 / !ok→503.
//
// Rodar: npx tsx scripts/smoke-healthz.ts

import { checkReadiness } from '../src/edge/server';

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

const okDep = () => Promise.resolve(1);
const downDep = () => Promise.reject(new Error('down'));

async function run(): Promise<void> {
  console.log('Readiness — checkReadiness');

  {
    const r = await checkReadiness({ pingRedis: okDep, pingDb: okDep });
    eq('tudo OK → ok:true (rota=200)', r.ok, true);
    eq('checks todos true', r.checks, { server: true, redis: true, database: true });
  }
  {
    const r = await checkReadiness({ pingRedis: downDep, pingDb: okDep });
    eq('Redis down → ok:false (rota=503)', r.ok, false);
    eq('redis:false, database:true', r.checks, { server: true, redis: false, database: true });
  }
  {
    const r = await checkReadiness({ pingRedis: okDep, pingDb: downDep });
    eq('DB down → ok:false (rota=503)', r.ok, false);
    eq('database:false, redis:true', r.checks, { server: true, redis: true, database: false });
  }
  {
    const r = await checkReadiness({ pingRedis: downDep, pingDb: downDep });
    eq('ambos down → ok:false', r.ok, false);
    eq('redis+database false', r.checks, { server: true, redis: false, database: false });
  }

  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail === 0 ? 0 : 1);
}
void run();
