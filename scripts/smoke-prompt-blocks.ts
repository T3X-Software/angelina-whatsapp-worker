// scripts/smoke-prompt-blocks.ts
//
// Smoke da lógica pura da Feature B (1.2/1.3): montagem do system prompt a
// partir dos blocos nomeados, na ordem fixa. Não toca DB/harness.
//
// Rodar: npx tsx scripts/smoke-prompt-blocks.ts

import { assembleSystemBlocks } from '../src/utils/prompt-blocks';

let pass = 0;
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}\n      esperado: ${JSON.stringify(want)}\n      obtido:   ${JSON.stringify(got)}`);
  }
}

console.log('Feature B — assembleSystemBlocks');

eq('undefined → vazio (fallback no caller)', assembleSystemBlocks(undefined), '');
eq('null → vazio', assembleSystemBlocks(null), '');
eq('objeto vazio → vazio', assembleSystemBlocks({}), '');

eq('um bloco só', assembleSystemBlocks({ identidade: 'Sou a Lua' }), 'Sou a Lua');

// Ordem fixa: mesmo com as chaves embaralhadas no objeto, sai na ordem canônica.
eq(
  'ordem fixa (objeto embaralhado)',
  assembleSystemBlocks({
    base_estabelecimento: 'BASE',
    identidade: 'ID',
    regras_duras: 'REGRAS',
    saudacao: 'OI',
    objetivo: 'OBJ',
    tom_de_voz: 'TOM',
  }),
  'ID\n\nOI\n\nTOM\n\nOBJ\n\nREGRAS\n\nBASE',
);

// Blocos ausentes são pulados (sem linhas em branco a mais).
eq(
  'pula ausentes',
  assembleSystemBlocks({ identidade: 'ID', objetivo: 'OBJ' }),
  'ID\n\nOBJ',
);

// Whitespace-only é filtrado e os presentes são trimados.
eq(
  'filtra whitespace + trim',
  assembleSystemBlocks({ identidade: '  ID  ', saudacao: '   ', tom_de_voz: 'TOM' }),
  'ID\n\nTOM',
);

// Defensivo: valores não-string ignorados.
eq(
  'ignora nao-string',
  assembleSystemBlocks({ identidade: 'ID', saudacao: 42 as unknown as string }),
  'ID',
);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
