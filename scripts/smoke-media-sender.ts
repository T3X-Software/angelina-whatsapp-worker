// scripts/smoke-media-sender.ts
//
// Feature 1.9 Commit 2 — valida a acumulação (collectPendingMedia), o gate
// (canSendMedia) e o hook media-sender com um ZapsterClient MOCKADO.
// Não chama a Zapster real.
//
// Rodar: npx tsx scripts/smoke-media-sender.ts

import {
  collectPendingMedia,
  canSendMedia,
} from '../src/utils/agent-media';
import { createMediaSenderHook } from '../src/hooks/media-sender';
import type { ZapsterClient } from '../src/zapster/client';
import type { HarnessContext } from '../src/harness/types';

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

// ── collectPendingMedia ──────────────────────────────────────────────────────
const entry = (id: string, url: string, title = 'T') => ({
  id,
  title,
  media_type: 'image',
  url,
  category: null,
  event_type: null,
  mime_type: 'image/jpeg',
});
console.log('Feature 1.9 — collectPendingMedia');
eq('sem select_media → vazio', collectPendingMedia([{ name: 'classify_lead', result: { success: true, data: {} } }]), []);
eq(
  'extrai mídias de select_media',
  collectPendingMedia([
    { name: 'select_media', result: { success: true, data: { media: [entry('a', 'https://x/a.jpg', 'Salão')] } } },
  ]),
  [{ id: 'a', url: 'https://x/a.jpg', caption: 'Salão', media_type: 'image' }],
);
eq(
  'dedup por id + ignora sem url',
  collectPendingMedia([
    { name: 'select_media', result: { success: true, data: { media: [entry('a', 'https://x/a.jpg'), entry('a', 'https://x/a.jpg')] } } },
    { name: 'select_media', result: { success: false, data: { media: [entry('b', 'https://x/b.jpg')] } } },
  ]).map((m) => m.id),
  ['a'],
);

// ── canSendMedia (Opção A — espelha response-guard) ──────────────────────────
// Assinatura: canSendMedia(aiState, isHumanActive, handoffAssumedAtSet).
console.log('Feature 1.9 — canSendMedia');
eq('AUTO + free → true', canSendMedia('AUTO', false, false), true);
eq('AFTER_HOURS_OK + free → true', canSendMedia('AFTER_HOURS_OK', false, false), true);
eq('assistido (humano, NÃO assumido) → true', canSendMedia('AUTO', true, false), true);
eq('handoff confirmado (humano + assumido) → false', canSendMedia('AUTO', true, true), false);
eq('PAUSED → false', canSendMedia('PAUSED', false, false), false);
eq('HUMAN_TAKEOVER → false', canSendMedia('HUMAN_TAKEOVER', false, false), false);

// ── hook media-sender (mock client) ──────────────────────────────────────────
function fakeCtx(opts: {
  media: Array<{ id: string; url: string; caption?: string; media_type: string }>;
  state?: { aiState?: string; isHumanActive?: boolean; assumedAtSet?: boolean };
}) {
  const sends: unknown[] = [];
  const events: string[] = [];
  const client = {
    send: async (input: unknown) => {
      sends.push(input);
      return { zapsterMessageId: 'mid' };
    },
  } as unknown as ZapsterClient;
  const ctx = {
    pendingMedia: opts.media,
    lead: { id: 'l', isHumanActive: false },
    contact: { id: 'c', phone: '5519', name: 'x', aiState: 'AUTO' },
    payload: { data: { sender: { id: '5519997124472' }, recipient: { type: 'chat' } } },
    eventBus: { emit: (t: string) => events.push(t) },
  } as unknown as HarnessContext;
  // Injeta o estado de gating — substitui o `loadMediaGateState` real (que iria
  // ao banco). Estrutura = MediaGateState.
  const loadState = async () => ({
    aiState: opts.state?.aiState ?? 'AUTO',
    isHumanActive: opts.state?.isHumanActive ?? false,
    assumedAtSet: opts.state?.assumedAtSet ?? false,
  });
  return { ctx, sends, events, client, loadState };
}

console.log('Feature 1.9 — hook media-sender');
async function run(): Promise<void> {
  {
    const f = fakeCtx({ media: [{ id: 'a', url: 'https://x/a.jpg', media_type: 'image' }, { id: 'b', url: 'https://x/b.jpg', caption: 'cardápio', media_type: 'document' }] });
    await createMediaSenderHook(f.client, f.loadState).run(f.ctx);
    eq('AUTO → envia 2 mídias', f.sends.length, 2);
    eq('emit media_sent + complete', f.events.includes('media_sender_complete'), true);
  }
  {
    // Opção A: modo assistido (humano, handoff NÃO assumido) agora LIBERA.
    const f = fakeCtx({ media: [{ id: 'a', url: 'https://x/a.jpg', media_type: 'image' }], state: { isHumanActive: true, assumedAtSet: false } });
    await createMediaSenderHook(f.client, f.loadState).run(f.ctx);
    eq('assistido → envia (Opção A)', f.sends.length, 1);
  }
  {
    // Handoff confirmado (humano assumiu) → bloqueia.
    const f = fakeCtx({ media: [{ id: 'a', url: 'https://x/a.jpg', media_type: 'image' }], state: { isHumanActive: true, assumedAtSet: true } });
    await createMediaSenderHook(f.client, f.loadState).run(f.ctx);
    eq('handoff confirmado → 0 envios', f.sends.length, 0);
    eq('emit media_send_skipped', f.events.includes('media_send_skipped'), true);
  }
  {
    const f = fakeCtx({ media: [{ id: 'a', url: 'https://x/a.jpg', media_type: 'image' }], state: { aiState: 'PAUSED' } });
    await createMediaSenderHook(f.client, f.loadState).run(f.ctx);
    eq('PAUSED → 0 envios', f.sends.length, 0);
  }
  {
    const f = fakeCtx({ media: [] });
    await createMediaSenderHook(f.client, f.loadState).run(f.ctx);
    eq('sem mídia → 0 envios, sem eventos', f.sends.length + f.events.length, 0);
  }

  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail === 0 ? 0 : 1);
}
void run();
