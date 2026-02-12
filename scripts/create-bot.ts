import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import * as schema from '../server/db/schema.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://termchat:termchat_dev@localhost:5432/termchat';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: tsx scripts/create-bot.ts <username> <owner_username> [display_name]');
    console.error('Example: tsx scripts/create-bot.ts my_bot alice "My Cool Bot"');
    process.exit(1);
  }

  const [botUsername, ownerUsername, displayName] = args;

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool, { schema });

  // Find owner
  const [owner] = await db.select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, ownerUsername))
    .limit(1);

  if (!owner) {
    console.error(`Owner user "${ownerUsername}" not found`);
    process.exit(1);
  }

  // Check if bot username is taken
  const [existing] = await db.select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, botUsername))
    .limit(1);

  if (existing) {
    console.error(`Username "${botUsername}" is already taken`);
    process.exit(1);
  }

  // Generate token
  const rawToken = `bot_${nanoid(12)}_${nanoid(32)}`;
  const tokenHash = await bcrypt.hash(rawToken, 12);

  const [bot] = await db.insert(schema.users).values({
    username: botUsername,
    displayName: displayName || botUsername,
    isBot: true,
    botToken: tokenHash,
    botOwnerId: owner.id,
    status: 'offline',
  }).returning();

  console.log('Bot created successfully!');
  console.log(`  ID: ${bot.id}`);
  console.log(`  Username: ${bot.username}`);
  console.log(`  Owner: ${ownerUsername}`);
  console.log(`  Token: ${rawToken}`);
  console.log('');
  console.log('Store this token securely. It will not be shown again.');

  await pool.end();
}

main().catch((err) => {
  console.error('Failed to create bot:', err);
  process.exit(1);
});
