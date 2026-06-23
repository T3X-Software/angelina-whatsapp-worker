// scripts/smoke-payload-audio.ts
//
// Feature 1.8 — valida que o parser captura a mídia de áudio no formato REAL do
// webhook Zapster (`data.content.media.url` + `metadata.ptt/duration`), conforme
// o schema AudioMediaMessage do OpenAPI. Trava a correção do bug de media_url.
//
// Rodar: npx tsx scripts/smoke-payload-audio.ts

import { parseWebhookPayload } from '../src/edge/payload';

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

// Payload REAL do webhook message.received (áudio) — schema fornecido pela doc.
const audioUrl = 'https://zapsterapi.s3.us-east-1.amazonaws.com/audio.mp3';
const audioWebhook = {
  id: 'evt_1234567890',
  type: 'message.received',
  created_at: '2026-06-23T10:00:00.000Z',
  data: {
    type: 'audio',
    id: '3EB02CEA860CC26D1B17B0',
    sent_at: '2026-06-23T10:00:00.000Z',
    recipient: { id: '5519999999999', type: 'chat' },
    sender: { id: '5519997124472' },
    content: {
      view_once: false,
      media: { url: audioUrl, metadata: { ptt: true, duration: 10 } },
    },
  },
};

console.log('Feature 1.8 — parseWebhookPayload (áudio content.media.url)');
const r = parseWebhookPayload(audioWebhook);
eq('parse success', r.success, true);
if (r.success) {
  const m = r.data.data.message;
  eq('type = audio', m.type, 'audio');
  eq('media.url capturado', m.media?.url, audioUrl);
  eq('media.ptt = true', m.media?.ptt, true);
  eq('media.duration = 10', m.media?.duration, 10);
  eq('text vazio (áudio)', m.text, undefined);
}

// Regressão: fallback legado content.url (workflows n8n) ainda funciona.
const legacy = {
  data: {
    id: 'x1',
    type: 'image',
    sender: { id: '551900000000' },
    recipient: { id: '551911111111', type: 'chat' },
    content: { url: 'https://legacy/img.jpg' },
  },
};
const rl = parseWebhookPayload(legacy);
console.log('Feature 1.8 — fallback legado content.url');
eq('legacy parse success', rl.success, true);
if (rl.success) eq('legacy url capturado', rl.data.data.message.media?.url, 'https://legacy/img.jpg');

// Texto puro: sem media.
const txt = {
  data: {
    id: 'x2',
    type: 'text',
    sender: { id: '551900000000' },
    recipient: { id: '551911111111', type: 'chat' },
    content: { text: 'oi' },
  },
};
const rt = parseWebhookPayload(txt);
console.log('Feature 1.8 — texto puro');
eq('texto parse success', rt.success, true);
if (rt.success) {
  eq('text capturado', rt.data.data.message.text, 'oi');
  eq('sem media', rt.data.data.message.media, undefined);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
