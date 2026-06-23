// scripts/smoke-transcribe.ts
//
// Smoke da lógica pura da Feature 1.8: decisão de tratamento (classifyInbound),
// uso da transcrição (transcriptionUsable) e mapeamento de extensão (extFromMime).
// NÃO chama a API Whisper (transcribeAudio faz IO e não é coberto aqui).
//
// Rodar: npx tsx scripts/smoke-transcribe.ts

import {
  classifyInbound,
  transcriptionUsable,
  extFromMime,
} from '../src/utils/transcribe';

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

console.log('Feature 1.8 — classifyInbound');
eq('texto → not_media', classifyInbound('text', false), 'not_media');
eq('áudio + url → transcribe', classifyInbound('audio', true), 'transcribe');
eq('áudio SEM url → fixed_response', classifyInbound('audio', false), 'fixed_response');
eq('imagem → fixed_response', classifyInbound('image', true), 'fixed_response');
eq('documento → fixed_response', classifyInbound('document', false), 'fixed_response');
eq('sticker → fixed_response', classifyInbound('sticker', true), 'fixed_response');

console.log('Feature 1.8 — transcriptionUsable');
eq('ok + texto → true', transcriptionUsable({ ok: true, text: 'oi tudo bem' }), true);
eq('ok + texto vazio → false', transcriptionUsable({ ok: true, text: '   ' }), false);
eq('ok sem texto → false', transcriptionUsable({ ok: true }), false);
eq('falha → false', transcriptionUsable({ ok: false, error: 'x' }), false);

console.log('Feature 1.8 — extFromMime');
eq('ogg/opus → ogg', extFromMime('audio/ogg; codecs=opus'), 'ogg');
eq('mpeg → mp3', extFromMime('audio/mpeg'), 'mp3');
eq('mp4 → m4a', extFromMime('audio/mp4'), 'm4a');
eq('wav → wav', extFromMime('audio/wav'), 'wav');
eq('webm → webm', extFromMime('audio/webm'), 'webm');
eq('undefined → ogg (default WhatsApp)', extFromMime(undefined), 'ogg');
eq('desconhecido → ogg', extFromMime('application/octet-stream'), 'ogg');

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
