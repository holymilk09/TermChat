import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://termchat:termchat_dev@localhost:5432/termchat';

async function main() {
  console.log('Running migrations...');

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: './server/db/migrations' });

  console.log('Migrations complete!');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
