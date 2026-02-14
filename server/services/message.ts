import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, messageStatus, conversations, users, attachments } from '../db/schema.js';
import { redisPub } from './redis.js';
import { deliverWebhook } from './webhook.js';
import { logger } from './logger.js';

// Central message service — single source of truth for creating messages.
// Used by REST route, WS handler, agent-gateway, and openclaw bridge.

export async function createMessage(opts: {
  conversationId: string;
  senderId: string;
  content?: string | null;
  type?: string;
  replyToId?: string | null;
  metadata?: Record<string, unknown>;
  attachmentIds?: string[];
}) {
  const { conversationId, senderId, content = null, type = 'text', replyToId, metadata, attachmentIds } = opts;

  // Atomic seq assignment + insert inside a transaction with advisory lock.
  // pg_advisory_xact_lock scopes the lock to this transaction; hashtext gives
  // a stable int4 from the conversation UUID so concurrent inserts to the
  // same conversation serialize while different conversations proceed in parallel.
  const [message] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))`);

    const [seqResult] = await tx.select({
      nextSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0) + 1`,
    })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    return tx.insert(messages).values({
      conversationId,
      senderId,
      seq: seqResult.nextSeq,
      type,
      content,
      replyToId: replyToId || null,
      metadata: metadata || {},
    }).returning();
  });

  // Link pre-uploaded attachments to this message
  if (attachmentIds?.length) {
    for (const attachmentId of attachmentIds) {
      await db.update(attachments)
        .set({ messageId: message.id })
        .where(eq(attachments.id, attachmentId));
    }
  }

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

  // Create status records for other members (batch insert)
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

  // Deliver webhooks to bot members (non-blocking)
  for (const member of members) {
    if (member.userId !== senderId) {
      db.select({ isBot: users.isBot })
        .from(users)
        .where(and(eq(users.id, member.userId), eq(users.isBot, true)))
        .limit(1)
        .then(([user]) => {
          if (user) {
            deliverWebhook(member.userId, 'message.new', messageWithSender).catch(err => {
              logger.error({ err, botUserId: member.userId }, 'Failed to deliver webhook');
            });
          }
        })
        .catch(() => {});
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
