import { Hono } from 'hono';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, users, messageStatus, conversations } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, sendMessageSchema, editMessageSchema } from '../middleware/validate.js';
import { messageRateLimit } from '../middleware/rate-limit.js';
import { redisPub } from '../services/redis.js';
import { logger } from '../services/logger.js';

const messagesRouter = new Hono();

messagesRouter.use('*', authMiddleware);

// Helper: check if user is member of conversation
async function checkMembership(convId: string, userId: string) {
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);
  return membership;
}

// Helper: get next sequence number for conversation
async function getNextSeq(convId: string): Promise<number> {
  const [result] = await db.select({
    maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0) + 1`,
  })
    .from(messages)
    .where(eq(messages.conversationId, convId));
  return result.maxSeq;
}

// GET /api/conversations/:convId/messages — paginated messages
messagesRouter.get('/:convId/messages', async (c) => {
  const userId = c.get('userId');
  const convId = c.req.param('convId');
  const before = c.req.query('before'); // seq number
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);

  const membership = await checkMembership(convId, userId);
  if (!membership) {
    return c.json({ error: 'forbidden', message: 'Not a member of this conversation' }, 403);
  }

  let query = db.select({
    id: messages.id,
    conversationId: messages.conversationId,
    senderId: messages.senderId,
    seq: messages.seq,
    type: messages.type,
    content: messages.content,
    metadata: messages.metadata,
    replyToId: messages.replyToId,
    editedAt: messages.editedAt,
    deletedAt: messages.deletedAt,
    createdAt: messages.createdAt,
    senderUsername: users.username,
    senderDisplayName: users.displayName,
    senderAvatarUrl: users.avatarUrl,
    senderIsBot: users.isBot,
  })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(
      before
        ? and(eq(messages.conversationId, convId), lt(messages.seq, parseInt(before)))
        : eq(messages.conversationId, convId)
    )
    .orderBy(desc(messages.seq))
    .limit(limit + 1); // Fetch one extra to check if there are more

  const result = await query;
  const hasMore = result.length > limit;
  const data = result.slice(0, limit).map(row => ({
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    seq: row.seq,
    type: row.type,
    content: row.deletedAt ? null : row.content,
    metadata: row.metadata,
    replyToId: row.replyToId,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    sender: {
      id: row.senderId,
      username: row.senderUsername,
      displayName: row.senderDisplayName,
      avatarUrl: row.senderAvatarUrl,
      isBot: row.senderIsBot,
    },
  }));

  return c.json({ data, hasMore });
});

// POST /api/conversations/:convId/messages — send message
messagesRouter.post('/:convId/messages', messageRateLimit, validate(sendMessageSchema), async (c) => {
  const userId = c.get('userId');
  const convId = c.req.param('convId');
  const body = (c as any).get('validatedBody') as {
    content: string;
    type: string;
    replyToId?: string;
    metadata?: Record<string, unknown>;
  };

  const membership = await checkMembership(convId, userId);
  if (!membership) {
    return c.json({ error: 'forbidden', message: 'Not a member of this conversation' }, 403);
  }

  const seq = await getNextSeq(convId);

  const [message] = await db.insert(messages).values({
    conversationId: convId,
    senderId: userId,
    seq,
    type: body.type,
    content: body.content,
    metadata: body.metadata || {},
    replyToId: body.replyToId || null,
  }).returning();

  // Get sender info
  const [sender] = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Update conversation's updatedAt
  await db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, convId));

  // Create message status for all members (except sender)
  const members = await db.select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, convId));

  for (const member of members) {
    if (member.userId !== userId) {
      await db.insert(messageStatus).values({
        messageId: message.id,
        userId: member.userId,
        status: 'sent',
      });
    }
  }

  const messageWithSender = {
    ...message,
    sender,
  };

  // Broadcast to conversation channel
  redisPub.publish(`conv:${convId}`, JSON.stringify({
    type: 'message.new',
    data: messageWithSender,
  }));

  logger.debug({ messageId: message.id, convId }, 'Message sent');

  return c.json(messageWithSender, 201);
});

// PATCH /api/messages/:id — edit message
messagesRouter.patch('/edit/:id', validate(editMessageSchema), async (c) => {
  const userId = c.get('userId');
  const messageId = c.req.param('id');
  const body = (c as any).get('validatedBody') as { content: string };

  const [msg] = await db.select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!msg) {
    return c.json({ error: 'not_found', message: 'Message not found' }, 404);
  }

  if (msg.senderId !== userId) {
    return c.json({ error: 'forbidden', message: 'You can only edit your own messages' }, 403);
  }

  if (msg.deletedAt) {
    return c.json({ error: 'gone', message: 'Message has been deleted' }, 410);
  }

  const [updated] = await db.update(messages)
    .set({ content: body.content, editedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();

  redisPub.publish(`conv:${msg.conversationId}`, JSON.stringify({
    type: 'message.edit',
    data: { id: messageId, content: body.content, editedAt: updated.editedAt },
  }));

  return c.json(updated);
});

// DELETE /api/messages/:id — soft delete
messagesRouter.delete('/delete/:id', async (c) => {
  const userId = c.get('userId');
  const messageId = c.req.param('id');

  const [msg] = await db.select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!msg) {
    return c.json({ error: 'not_found', message: 'Message not found' }, 404);
  }

  if (msg.senderId !== userId) {
    // Check if user is admin of the conversation
    const membership = await checkMembership(msg.conversationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return c.json({ error: 'forbidden', message: 'You can only delete your own messages' }, 403);
    }
  }

  await db.update(messages)
    .set({ deletedAt: new Date() })
    .where(eq(messages.id, messageId));

  redisPub.publish(`conv:${msg.conversationId}`, JSON.stringify({
    type: 'message.delete',
    data: { id: messageId },
  }));

  return c.json({ message: 'Message deleted' });
});

// POST /api/messages/:id/read — mark message as read
messagesRouter.post('/:convId/read', async (c) => {
  const userId = c.get('userId');
  const convId = c.req.param('convId');

  const membership = await checkMembership(convId, userId);
  if (!membership) {
    return c.json({ error: 'forbidden', message: 'Not a member of this conversation' }, 403);
  }

  // Update last_read_at for the member
  await db.update(conversationMembers)
    .set({ lastReadAt: new Date() })
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, userId)
    ));

  // Update message_status for unread messages
  const unreadStatuses = await db.select({ messageId: messageStatus.messageId })
    .from(messageStatus)
    .innerJoin(messages, eq(messageStatus.messageId, messages.id))
    .where(and(
      eq(messages.conversationId, convId),
      eq(messageStatus.userId, userId),
      sql`${messageStatus.status} != 'read'`
    ));

  for (const s of unreadStatuses) {
    await db.update(messageStatus)
      .set({ status: 'read', readAt: new Date() })
      .where(and(
        eq(messageStatus.messageId, s.messageId),
        eq(messageStatus.userId, userId)
      ));

    redisPub.publish(`conv:${convId}`, JSON.stringify({
      type: 'status.read',
      data: { messageId: s.messageId },
    }));
  }

  return c.json({ message: 'Messages marked as read' });
});

export default messagesRouter;
