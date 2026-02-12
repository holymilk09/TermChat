import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import bcrypt from 'bcrypt';
import * as schema from '../server/db/schema.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://termchat:termchat_dev@localhost:5432/termchat';

async function main() {
  console.log('Seeding database...');

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool, { schema });

  // Create demo users
  const passwordHash = await bcrypt.hash('password123', 12);

  const [alice] = await db.insert(schema.users).values({
    username: 'alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    passwordHash,
    status: 'offline',
  }).returning();

  const [bob] = await db.insert(schema.users).values({
    username: 'bob',
    displayName: 'Bob',
    email: 'bob@example.com',
    passwordHash,
    status: 'offline',
  }).returning();

  const [charlie] = await db.insert(schema.users).values({
    username: 'charlie',
    displayName: 'Charlie',
    email: 'charlie@example.com',
    passwordHash,
    status: 'offline',
  }).returning();

  // Create a bot user
  const botTokenHash = await bcrypt.hash('bot_demo_token_12345', 12);
  const [brainBot] = await db.insert(schema.users).values({
    username: 'brain_bot',
    displayName: 'Brain',
    isBot: true,
    botToken: botTokenHash,
    botOwnerId: alice.id,
    status: 'offline',
  }).returning();

  console.log('Created users: alice, bob, charlie, brain_bot');

  // Create a DM between alice and bob
  const [dm] = await db.insert(schema.conversations).values({
    type: 'dm',
    creatorId: alice.id,
  }).returning();

  await db.insert(schema.conversationMembers).values([
    { conversationId: dm.id, userId: alice.id, role: 'owner' },
    { conversationId: dm.id, userId: bob.id, role: 'member' },
  ]);

  // Create a group conversation
  const [group] = await db.insert(schema.conversations).values({
    type: 'group',
    name: 'TermChat Dev',
    description: 'Development discussion for TermChat',
    creatorId: alice.id,
  }).returning();

  await db.insert(schema.conversationMembers).values([
    { conversationId: group.id, userId: alice.id, role: 'owner' },
    { conversationId: group.id, userId: bob.id, role: 'admin' },
    { conversationId: group.id, userId: charlie.id, role: 'member' },
    { conversationId: group.id, userId: brainBot.id, role: 'bot' },
  ]);

  console.log('Created conversations: DM (alice ↔ bob), Group (TermChat Dev)');

  // Seed some messages in the DM
  const dmMessages = [
    { senderId: alice.id, content: 'Hey Bob! Have you seen the new TermChat architecture?', seq: 1 },
    { senderId: bob.id, content: 'Yes! The WebSocket + Redis PubSub pattern looks solid.', seq: 2 },
    { senderId: alice.id, content: 'Agreed. Should we start with the core messaging or the agent system?', seq: 3 },
    { senderId: bob.id, content: 'Core messaging first. We need a solid foundation before adding AI agents.', seq: 4 },
    { senderId: alice.id, content: 'Makes sense. I\'ll start on the DB schema and you handle the WS server?', seq: 5 },
    { senderId: bob.id, content: 'Deal! Let me set up the Redis PubSub rooms first.', seq: 6 },
  ];

  for (const msg of dmMessages) {
    await db.insert(schema.messages).values({
      conversationId: dm.id,
      senderId: msg.senderId,
      seq: msg.seq,
      type: 'text',
      content: msg.content,
    });
  }

  // Seed messages in the group
  const groupMessages = [
    { senderId: alice.id, content: 'Welcome to the TermChat Dev group!', seq: 1 },
    { senderId: bob.id, content: 'Excited to build this. The architecture doc is comprehensive.', seq: 2 },
    { senderId: charlie.id, content: 'Just joined! What can I help with?', seq: 3 },
    { senderId: alice.id, content: 'Charlie, can you start on the rate limiting middleware?', seq: 4 },
    { senderId: charlie.id, content: 'On it! Redis sliding window approach?', seq: 5 },
    { senderId: alice.id, content: 'Exactly. 60 msgs/min per user should be good for v1.', seq: 6 },
    { senderId: bob.id, content: 'I\'ve got the WebSocket server running with heartbeat detection.', seq: 7 },
    { senderId: alice.id, content: 'Nice! Let\'s also add the Brain bot to help with code reviews.', seq: 8 },
  ];

  for (const msg of groupMessages) {
    await db.insert(schema.messages).values({
      conversationId: group.id,
      senderId: msg.senderId,
      seq: msg.seq,
      type: 'text',
      content: msg.content,
    });
  }

  console.log('Seeded messages in conversations');

  // Create an agent for the brain bot
  await db.insert(schema.agents).values({
    botUserId: brainBot.id,
    ownerId: alice.id,
    slug: 'brain',
    name: 'Brain',
    icon: '🧠',
    model: 'anthropic/claude-opus-4-6',
    fallbackModels: ['anthropic/claude-sonnet-4-5'],
    scopes: ['read', 'write', 'exec', 'browser'],
    skills: ['orchestration', 'coding', 'research'],
    sandbox: 'non-main',
    heartbeat: '30m',
    isPrimary: true,
  });

  console.log('Created Brain agent');
  console.log('\nSeed complete! Demo credentials:');
  console.log('  alice / password123');
  console.log('  bob / password123');
  console.log('  charlie / password123');

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
