// scripts/smoke-zapster-media.ts
//
// Feature 1.9 — valida o schema do body com media (url XOR base64, text||media).
// Não chama a Zapster — testa só a validação Zod.
//
// Rodar: npx tsx scripts/smoke-zapster-media.ts

import { SendRequestSchema, MediaPayloadSchema } from '../src/zapster/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}
const ok = (s: { success: boolean }) => s.success === true;
const bad = (s: { success: boolean }) => s.success === false;

const BASE = { instance_id: 'inst_1', recipient: '5519999999999' };

console.log('Feature 1.9 — SendRequestSchema');
check('texto puro → ok', ok(SendRequestSchema.safeParse({ ...BASE, text: 'oi' })));
check('media url → ok', ok(SendRequestSchema.safeParse({ ...BASE, media: { url: 'https://x/y.jpg' } })));
check('media base64 → ok', ok(SendRequestSchema.safeParse({ ...BASE, media: { base64: 'AAAA' } })));
check('texto + media url → ok', ok(SendRequestSchema.safeParse({ ...BASE, text: 'veja', media: { url: 'https://x/y.jpg', caption: 'salão' } })));
check('sem text e sem media → FALHA', bad(SendRequestSchema.safeParse({ ...BASE })));
check('media com url E base64 → FALHA', bad(SendRequestSchema.safeParse({ ...BASE, media: { url: 'https://x/y.jpg', base64: 'AAAA' } })));
check('media sem url nem base64 → FALHA', bad(SendRequestSchema.safeParse({ ...BASE, media: { caption: 'só legenda' } })));
check('url inválida → FALHA', bad(SendRequestSchema.safeParse({ ...BASE, media: { url: 'não-é-url' } })));

console.log('Feature 1.9 — MediaPayloadSchema (campos opcionais)');
check('fileName + caption (url) → ok', ok(MediaPayloadSchema.safeParse({ url: 'https://x/d.pdf', fileName: 'menu.pdf', caption: 'cardápio' })));
check('ptt boolean (url) → ok', ok(MediaPayloadSchema.safeParse({ url: 'https://x/a.ogg', ptt: true })));

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
