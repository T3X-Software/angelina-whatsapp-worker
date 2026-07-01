// READ-ONLY: mostra os templates de follow-up de agent_configs (key angelina).
import { db, closeDb } from '../src/db/client';
import { agentConfigs } from '../src/db/schema';
import { eq } from 'drizzle-orm';

async function main() {
  const rows = await db.select().from(agentConfigs).where(eq(agentConfigs.key, 'angelina'));
  for (const r of rows) {
    const hp = r.hookParams as any;
    console.log('config id:', r.id, 'version:', r.version, 'active:', r.isActive);
    console.log('follow_up.templates:');
    console.log(JSON.stringify(hp?.follow_up?.templates ?? '(ausente)', null, 2));
  }
}
main().then(() => closeDb()).catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
