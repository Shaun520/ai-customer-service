import '../env.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://aics:aics@localhost:5432/aics';
  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client);
  console.log('[migrate] running migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[migrate] done');
  await client.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
