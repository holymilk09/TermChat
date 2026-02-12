import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, messageStatus, conversations, users } from '../db/schema.js';
import { redisPub } from './redis.js';
import { deliverWebhook } from './webhook.js';
import { logger } from './logger.js';

// Central message service — used by both REST and WebSocket handlers

export async function createMessage(opts: {
  conversationId: string;
  senderId: string;
  content: string;
  type?: string;
  replyToId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { conversationId, senderId, content, type = 'text', replyToId, metadata } = opts;

  // Get next seq
  const [seqResult] = await db.select({
    maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0) + 1`,
  })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  const [message] = await db.insert(messages).values({
    conversationId,
    senderId,
    seq: seqResult.maxSeq,
    type,
    content,
    replyToId: replyToId || null,
    metadata: metadata || {},
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
    .where(eq(users.id, senderId))
    .limit(1);

  // Update conversation timestamp
  await db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  // Create status records for other members
  const members = await db.select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));

  const statusInserts = members
    .filter(m => m.userId !== senderId)
    .map(m => ({
      messageId: message.id,
      userId: m.userId,
      status: 'sent' as const,
    }));

  if (statusInserts.length > 0) {
    await db.insert(messageStatus).values(statusInserts);
  }

  const messageWithSender = { ...message, sender };

  // Broadcast via Redis PubSub
  redisPub.publish(`conv:${conversationId}`, JSON.stringify({
    type: 'message.new',
    data: messageWithSender,
  }));

  // Deliver webhooks to bot members
  const botMembers = members.filter(m => m.userId !== senderId);
  for (const member of botMembers) {
    const [user] = await db.select({ isBot: users.isBot })
      .from(users)
      .where(eq(users.id, member.userId))
      .limit(1);

    if (user?.isBot) {
      deliverWebhook(member.userId, 'message.new', messageWithSender).catch(err => {
        logger.error({ err, botUserId: member.userId }, 'Failed to deliver webhook');
      });
    }
  }

  return messageWithSender;
}

export async function getUnreadCount(conversationId: string, userId: string): Promise<number> {
  const [membership] = await db.select({ lastReadAt: conversationMembers.lastReadAt })
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership?.lastReadAt) {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    return count;
  }

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      sql`${messages.createdAt} > ${membership.lastReadAt}`
    ));

  return count;
}
