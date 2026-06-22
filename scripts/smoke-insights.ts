// scripts/smoke-insights.ts
//
// Smoke do agente analista de conversas (feature conversation-insights).
// Roda UMA análise on-demand sobre um contact_id (default: a conversa real
// existente) chamando o Claude de verdade, persiste em conversation_insights
// e imprime o resumo. NÃO sobe Redis/BullMQ — é standalone.
//
// Uso:
//   npm run smoke:insights                 # usa o contato default
//   npx tsx scripts/smoke-insights.ts <contactId>

import { runInsightsAnalyst } from '../src/jobs/insights-analyst';
import { closeDb } from '../src/db/client';

const DEFAULT_CONTACT = '3d2e8b06-c10e-48de-bf59-ee420a048b77';

async function main(): Promise<void> {
  const contactId = process.argv[2] ?? DEFAULT_CONTACT;
  // eslint-disable-next-line no-console
  console.log(`[smoke-insights] analisando contact_id=${contactId}…`);
  const summary = await runInsightsAnalyst({
    trigger: 'on_demand',
    contactIds: [contactId],
  });
  // eslint-disable-next-line no-console
  console.log('[smoke-insights] resultado:', JSON.stringify(summary, null, 2));
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[smoke-insights] erro:', err);
    await closeDb();
    process.exit(1);
  });
