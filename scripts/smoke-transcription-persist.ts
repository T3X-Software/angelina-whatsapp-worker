// scripts/smoke-transcription-persist.ts
//
// M1 — valida que o L1 (mapRowToLLMMessage) surfa a transcrição do áudio quando
// `text` é NULL (mensagem de áudio do cliente). Função pura — não toca DB.
//
// Contexto: o loop [9.5] grava a transcrição em `messages.transcription` após o
// Whisper; este smoke prova que o L1 passa a usá-la como conteúdo do turno
// `user` em turnos futuros (antes a row de áudio aparecia VAZIA → context loss).
//
// Rodar: npx tsx scripts/smoke-transcription-persist.ts

import {
  mapRowToLLMMessage,
  type RawMessageRow,
} from '../src/memory/l1-conversation';

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

function row(partial: Partial<RawMessageRow>): RawMessageRow {
  return {
    id: 'm1',
    direction: 'INBOUND',
    role: 'user',
    text: null,
    transcription: null,
    tool_name: null,
    tool_args: null,
    tool_result: null,
    tool_use_message_id: null,
    send_status: null,
    created_at: '2026-06-26T00:00:00Z',
    ...partial,
  };
}

console.log('M1 — L1 surfa transcrição');

eq(
  'áudio transcrito (text NULL + transcription) → content = transcription',
  mapRowToLLMMessage(row({ text: null, transcription: 'tem foto do buffet?' })),
  { role: 'user', content: 'tem foto do buffet?' },
);
eq(
  'texto presente vence transcription',
  mapRowToLLMMessage(row({ text: 'oi tudo bem?', transcription: 'ignorar' })),
  { role: 'user', content: 'oi tudo bem?' },
);
eq(
  'ambos vazios → null (pula no histórico)',
  mapRowToLLMMessage(row({ text: null, transcription: null })),
  null,
);
eq(
  'transcription só whitespace → null',
  mapRowToLLMMessage(row({ text: null, transcription: '   ' })),
  null,
);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
