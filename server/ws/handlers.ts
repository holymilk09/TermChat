import type { WebSocket } from 'ws';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, users, messageStatus, conversations } from '../db/schema.js';
import { redis, redisPub } from '../services/redis.js';
import { logger } from '../services/logger.js';
import { subscribeToChannel, publishToChannel } from './rooms.js';
import type { ClientEvent } from '../../shared/types.js';

export async function handleClientEvent(ws: WebSocket, userId: string, username: string, event: ClientEvent) {
  switch (event.type) {
    case 'message.send':
      await handleMessageSend(ws, userId, event.data);
      break;
    case 'typing.start':
      await handleTypingStart(userId, username, event.data.conversationId);
      break;
    case 'typing.stop':
      await handleTypingStop(userId, event.data.conversationId);
      break;
    case 'message.read':
      await handleMessageRead(userId, event.data.conversationId, event.data.upToSeq);
      break;
    default:
      logger.warn({ type: (event as any).type }, 'Unknown client event type');
  }
}

async function handleMessageSend(
  ws: WebSocket,
  userId: string,
  data: { conversationId: string; content: string; replyTo?: string }
) {
  // Check membership
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, data.conversationId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Not a member of this conversation' } }));
    return;
  }

  // Get next sequence number
  const [seqResult] = await db.select({
    maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0) + 1`,
  })
    .from(messages)
    .where(eq(messages.conversationId, data.conversationId));

  const [message] = await db.insert(messages).values({
    conversationId: data.conversationId,
    senderId: userId,
    seq: seqResult.maxSeq,
    type: 'text',
    content: data.content,
    replyToId: data.replyTo || null,
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

  // Update conversation timestamp
  await db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, data.conversationId));

  // Create status records for other members
  const members = await db.select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, data.conversationId));

  for (const member of members) {
    if (member.userId !== userId) {
      await db.insert(messageStatus).values({
        messageId: message.id,
        userId: member.userId,
        status: 'sent',
      });
    }
  }

  // Clear typing indicator
  await redis.del(`typing:${data.conversationId}:${userId}`);

  // Broadcast
  publishToChannel(`conv:${data.conversationId}`, {
    type: 'message.new',
    data: { ...message, sender },
  });
}

async function handleTypingStart(userId: string, username: string, conversationId: string) {
  await redis.setex(`typing:${conversationId}:${userId}`, 5, '1');
  publishToChannel(`conv:${conversationId}`, {
    type: 'typing.start',
    data: { conversationId, userId, username },
  });
}

async function handleTypingStop(userId: string, conversationId: string) {
  await redis.del(`typing:${conversationId}:${userId}`);
  publishToChannel(`conv:${conversationId}`, {
    type: 'typing.stop',
    data: { conversationId, userId },
  });
}

async function handleMessageRead(userId: string, conversationId: string, upToSeq: number) {
  // Update last_read_at
  await db.update(conversationMembers)
    .set({ lastReadAt: new Date() })
    .where(and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId)
    ));

  // Update message statuses
  const unread = await db.select({
    messageId: messageStatus.messageId,
  })
    .from(messageStatus)
    .innerJoin(messages, eq(messageStatus.messageId, messages.id))
    .where(and(
      eq(messages.conversationId, conversationId),
      eq(messageStatus.userId, userId),
      sql`${messageStatus.status} != 'read'`,
      sql`${messages.seq} <= ${upToSeq}`
    ));

  for (const s of unread) {
    await db.update(messageStatus)
      .set({ status: 'read', readAt: new Date() })
      .where(and(
        eq(messageStatus.messageId, s.messageId),
        eq(messageStatus.userId, userId)
      ));
  }
}

export async function subscribeUserToConversations(ws: WebSocket, userId: string) {
  const memberships = await db.select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, userId));

  for (const m of memberships) {
    subscribeToChannel(ws, `conv:${m.conversationId}`);
  }

  logger.debug({ userId, count: memberships.length }, 'Subscribed user to conversation channels');
}
