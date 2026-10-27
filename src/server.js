import { initDb, query, closeDb } from './db/index.js';
import { ensureAdmin } from './services/users.js';
import { seedDemo } from './db/seed.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  const db = await initDb();
  console.log(`Database ready (${db.kind})`);
  await ensureAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

  if (process.env.SEED_DEMO === 'true') {
    const [{ n }] = await query('SELECT count(*)::int AS n FROM programs');
    if (n === 0) {
      await seedDemo();
      console.log('Seeded demo data');
    }
  }

  const server = createApp().listen(PORT, () => console.log(`ImpactBridge listening on http://localhost:${PORT}`));

  const shutdown = () => {
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
