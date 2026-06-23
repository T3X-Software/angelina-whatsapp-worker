// scripts/smoke-select-media.ts
//
// Feature 1.9 — valida a lógica pura da tool select_media: normalização do
// input (filtros + clamp do limit) e mapeamento da linha. Não toca o banco.
//
// Rodar: npx tsx scripts/smoke-select-media.ts

import {
  normalizeSelectMediaInput,
  mapMediaRow,
  SELECT_MEDIA_DEFAULT_LIMIT,
  SELECT_MEDIA_MAX_LIMIT,
} from '../src/utils/agent-media';

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

console.log('Feature 1.9 — normalizeSelectMediaInput');
eq('vazio → defaults', normalizeSelectMediaInput({}), {
  category: null,
  event_type: null,
  limit: SELECT_MEDIA_DEFAULT_LIMIT,
});
eq('filtros com trim', normalizeSelectMediaInput({ category: '  salao ', event_type: 'casamento' }), {
  category: 'salao',
  event_type: 'casamento',
  limit: SELECT_MEDIA_DEFAULT_LIMIT,
});
eq('string vazia → null', normalizeSelectMediaInput({ category: '   ' }), {
  category: null,
  event_type: null,
  limit: SELECT_MEDIA_DEFAULT_LIMIT,
});
eq('limit válido', normalizeSelectMediaInput({ limit: 3 }), { category: null, event_type: null, limit: 3 });
eq('limit acima do máx → clamp', normalizeSelectMediaInput({ limit: 999 }), {
  category: null,
  event_type: null,
  limit: SELECT_MEDIA_MAX_LIMIT,
});
eq('limit zero → default', normalizeSelectMediaInput({ limit: 0 }), {
  category: null,
  event_type: null,
  limit: SELECT_MEDIA_DEFAULT_LIMIT,
});
eq('limit negativo → default', normalizeSelectMediaInput({ limit: -5 }), {
  category: null,
  event_type: null,
  limit: SELECT_MEDIA_DEFAULT_LIMIT,
});

console.log('Feature 1.9 — mapMediaRow');
eq(
  'renomeia public_url → url',
  mapMediaRow({
    id: 'm1',
    title: 'Salão principal',
    category: 'salao',
    event_type: 'casamento',
    public_url: 'https://bucket/salao.jpg',
    media_type: 'image',
    mime_type: 'image/jpeg',
  }),
  {
    id: 'm1',
    title: 'Salão principal',
    media_type: 'image',
    url: 'https://bucket/salao.jpg',
    category: 'salao',
    event_type: 'casamento',
    mime_type: 'image/jpeg',
  },
);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
