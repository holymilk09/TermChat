import { Hono } from 'hono';
import { eq, and, desc, gt, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { users, webhooks, messages, conversationMembers, conversations } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { redis, redisPub } from '../services/redis.js';
import { logger } from '../services/logger.js';

const botsRouter = new Hono();

// ── Bot Management (requires user auth) ──────────

// POST /api/bots — create a new bot
botsRouter.post('/', authMiddleware, async (c) => {
  const ownerId = c.get('userId');
  const body = await c.req.json();

  const { username, displayName } = body;

  if (!username || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return c.json({ error: 'validation_error', message: 'Invalid bot username' }, 400);
  }

  // Check username availability
  const [existing] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (existing) {
    return c.json({ error: 'conflict', message: 'Username already taken' }, 409);
  }

  // Generate bot token: bot_{uuid}_{random}
  const rawToken = `bot_${nanoid(12)}_${nanoid(32)}`;
  const tokenHash = await bcrypt.hash(rawToken, 12);

  const [bot] = await db.insert(users).values({
    username,
    displayName: displayName || username,
    isBot: true,
    botToken: tokenHash,
    botOwnerId: ownerId,
    status: 'offline',
  }).returning({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    isBot: users.isBot,
    createdAt: users.createdAt,
  });

  logger.info({ botId: bot.id, username }, 'Bot created');

  // Return token only once (Telegram pattern)
  return c.json({
    bot,
    token: rawToken,
    warning: 'Store this token securely. It will not be shown again.',
  }, 201);
});

// GET /api/bots/:id — get bot info
botsRouter.get('/:id', authMiddleware, async (c) => {
  const botId = c.req.param('id');
  const ownerId = c.get('userId');

  const [bot] = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
    status: users.status,
    createdAt: users.createdAt,
  })
    .from(users)
    .where(and(eq(users.id, botId), eq(users.isBot, true), eq(users.botOwnerId, ownerId)))
    .limit(1);

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found' }, 404);
  }

  return c.json(bot);
});

// PATCH /api/bots/:id — update bot
botsRouter.patch('/:id', authMiddleware, async (c) => {
  const botId = c.req.param('id');
  const ownerId = c.get('userId');
  const body = await c.req.json();

  const [bot] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, botId), eq(users.isBot, true), eq(users.botOwnerId, ownerId)))
    .limit(1);

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found' }, 404);
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.displayName !== undefined) updateData.displayName = body.displayName;
  if (body.avatarUrl !== undefined) updateData.avatarUrl = body.avatarUrl;

  const [updated] = await db.update(users)
    .set(updateData)
    .where(eq(users.id, botId))
    .returning({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    });

  return c.json(updated);
});

// DELETE /api/bots/:id — delete bot
botsRouter.delete('/:id', authMiddleware, async (c) => {
  const botId = c.req.param('id');
  const ownerId = c.get('userId');

  const [bot] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, botId), eq(users.isBot, true), eq(users.botOwnerId, ownerId)))
    .limit(1);

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found' }, 404);
  }

  await db.delete(users).where(eq(users.id, botId));
  logger.info({ botId }, 'Bot deleted');

  return c.json({ message: 'Bot deleted' });
});

// POST /api/bots/:id/webhook — set webhook for bot
botsRouter.post('/:id/webhook', authMiddleware, async (c) => {
  const botId = c.req.param('id');
  const ownerId = c.get('userId');
  const body = await c.req.json();

  const [bot] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, botId), eq(users.isBot, true), eq(users.botOwnerId, ownerId)))
    .limit(1);

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found' }, 404);
  }

  if (!body.url) {
    return c.json({ error: 'validation_error', message: 'url is required' }, 400);
  }

  // Upsert webhook
  const [existing] = await db.select({ id: webhooks.id })
    .from(webhooks)
    .where(eq(webhooks.botUserId, botId))
    .limit(1);

  if (existing) {
    const [updated] = await db.update(webhooks)
      .set({
        url: body.url,
        secret: body.secret || null,
        events: body.events || ['message.new'],
        active: true,
        failureCount: 0,
      })
      .where(eq(webhooks.id, existing.id))
      .returning();
    return c.json(updated);
  }

  const [webhook] = await db.insert(webhooks).values({
    botUserId: botId,
    url: body.url,
    secret: body.secret || null,
    events: body.events || ['message.new'],
  }).returning();

  return c.json(webhook, 201);
});

// ── Bot API (authenticated via bot token) ────────

// Middleware: authenticate bot via token
async function botTokenAuth(c: any, next: any) {
  const authHeader = c.req.header('Authorization');
  let token: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (authHeader?.startsWith('Bot ')) {
    token = authHeader.slice(4);
  }

  if (!token) {
    return c.json({ error: 'unauthorized', message: 'Bot token required' }, 401);
  }

  // Find all bot users and check token (bcrypt comparison)
  const bots = await db.select({
    id: users.id,
    username: users.username,
    botToken: users.botToken,
  })
    .from(users)
    .where(eq(users.isBot, true));

  for (const bot of bots) {
    if (bot.botToken && await bcrypt.compare(token, bot.botToken)) {
      c.set('botId' as never, bot.id as never);
      c.set('botUsername' as never, bot.username as never);
      return next();
    }
  }

  return c.json({ error: 'unauthorized', message: 'Invalid bot token' }, 401);
}

// GET /api/bot/getUpdates — long-polling for bot updates (Telegram pattern)
botsRouter.get('/api/getUpdates', botTokenAuth, async (c: any) => {
  const botId = c.get('botId') as string;
  const offset = parseInt(c.req.query('offset') || '0');
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 100);
  const timeout = Math.min(parseInt(c.req.query('timeout') || '0'), 30);

  // Get conversations the bot is a member of
  const memberships = await db.select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, botId));

  if (memberships.length === 0) {
    return c.json({ ok: true, result: [] });
  }

  const convIds = memberships.map(m => m.conversationId);

  // Check Redis for cached update offset
  const lastOffset = await redis.get(`bot:offset:${botId}`);
  const effectiveOffset = offset || (lastOffset ? parseInt(lastOffset) : 0);

  const fetchUpdates = async () => {
    const msgs = await db.select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      seq: messages.seq,
      type: messages.type,
      content: messages.content,
      createdAt: messages.createdAt,
      senderUsername: users.username,
      senderIsBot: users.isBot,
    })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(and(
        sql`${messages.conversationId} = ANY(${convIds})`,
        sql`${messages.senderId} != ${botId}`,
        gt(messages.seq, effectiveOffset),
        sql`${messages.deletedAt} IS NULL`
      ))
      .orderBy(messages.createdAt)
      .limit(limit);

    return msgs;
  };

  let result = await fetchUpdates();

  // Long polling: wait up to `timeout` seconds for new messages
  if (result.length === 0 && timeout > 0) {
    const startTime = Date.now();
    const timeoutMs = timeout * 1000;

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      result = await fetchUpdates();
      if (result.length > 0) break;
    }
  }

  // Format as Telegram-compatible updates
  const updates = result.map((msg, idx) => ({
    update_id: effectiveOffset + idx + 1,
    message: {
      message_id: msg.id,
      from: {
        id: msg.senderId,
        username: msg.senderUsername,
        is_bot: msg.senderIsBot,
      },
      chat: {
        id: msg.conversationId,
        type: 'group', // simplified
      },
      date: Math.floor(new Date(msg.createdAt).getTime() / 1000),
      text: msg.content,
    },
  }));

  // Store offset
  if (updates.length > 0) {
    const maxUpdateId = updates[updates.length - 1].update_id;
    await redis.set(`bot:offset:${botId}`, String(maxUpdateId));
  }

  return c.json({ ok: true, result: updates });
});

// POST /api/bot/sendMessage — bot sends a message
botsRouter.post('/api/sendMessage', botTokenAuth, async (c: any) => {
  const botId = c.get('botId') as string;
  const body = await c.req.json();

  const { chat_id, text, reply_to_message_id } = body;

  if (!chat_id || !text) {
    return c.json({ error: 'validation_error', message: 'chat_id and text are required' }, 400);
  }

  // Verify bot is member
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, chat_id),
      eq(conversationMembers.userId, botId)
    ))
    .limit(1);

  if (!membership) {
    return c.json({ error: 'forbidden', message: 'Bot is not a member of this chat' }, 403);
  }

  // Get next seq
  const [seqResult] = await db.select({
    maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0) + 1`,
  })
    .from(messages)
    .where(eq(messages.conversationId, chat_id));

  const [msg] = await db.insert(messages).values({
    conversationId: chat_id,
    senderId: botId,
    seq: seqResult.maxSeq,
    type: 'text',
    content: text,
    replyToId: reply_to_message_id || null,
  }).returning();

  // Get bot info
  const [botUser] = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
  })
    .from(users)
    .where(eq(users.id, botId))
    .limit(1);

  // Broadcast
  redisPub.publish(`conv:${chat_id}`, JSON.stringify({
    type: 'message.new',
    data: { ...msg, sender: botUser },
  }));

  return c.json({
    ok: true,
    result: {
      message_id: msg.id,
      from: { id: botUser.id, username: botUser.username, is_bot: true },
      chat: { id: chat_id },
      date: Math.floor(new Date(msg.createdAt).getTime() / 1000),
      text: msg.content,
    },
  });
});

// POST /api/bot/editMessage — bot edits a message
botsRouter.post('/api/editMessage', botTokenAuth, async (c: any) => {
  const botId = c.get('botId') as string;
  const body = await c.req.json();

  const { message_id, text } = body;

  if (!message_id || !text) {
    return c.json({ error: 'validation_error', message: 'message_id and text are required' }, 400);
  }

  const [msg] = await db.select()
    .from(messages)
    .where(and(eq(messages.id, message_id), eq(messages.senderId, botId)))
    .limit(1);

  if (!msg) {
    return c.json({ error: 'not_found', message: 'Message not found or not owned by bot' }, 404);
  }

  const [updated] = await db.update(messages)
    .set({ content: text, editedAt: new Date() })
    .where(eq(messages.id, message_id))
    .returning();

  redisPub.publish(`conv:${msg.conversationId}`, JSON.stringify({
    type: 'message.edit',
    data: { id: message_id, content: text, editedAt: updated.editedAt },
  }));

  return c.json({ ok: true, result: updated });
});

// POST /api/bot/deleteMessage — bot deletes a message
botsRouter.post('/api/deleteMessage', botTokenAuth, async (c: any) => {
  const botId = c.get('botId') as string;
  const body = await c.req.json();

  const { message_id } = body;

  if (!message_id) {
    return c.json({ error: 'validation_error', message: 'message_id is required' }, 400);
  }

  const [msg] = await db.select()
    .from(messages)
    .where(and(eq(messages.id, message_id), eq(messages.senderId, botId)))
    .limit(1);

  if (!msg) {
    return c.json({ error: 'not_found', message: 'Message not found or not owned by bot' }, 404);
  }

  await db.update(messages)
    .set({ deletedAt: new Date() })
    .where(eq(messages.id, message_id));

  redisPub.publish(`conv:${msg.conversationId}`, JSON.stringify({
    type: 'message.delete',
    data: { id: message_id },
  }));

  return c.json({ ok: true });
});

export default botsRouter;
