import { Hono } from 'hono';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversations, conversationMembers, users, messages } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, createConversationSchema, addMemberSchema } from '../middleware/validate.js';
import { redisPub } from '../services/redis.js';
import { logger } from '../services/logger.js';

const conversationsRouter = new Hono();

conversationsRouter.use('*', authMiddleware);

// GET /api/conversations — list user's conversations
conversationsRouter.get('/', async (c) => {
  const userId = c.get('userId');

  // Get conversations the user is a member of
  const memberOf = await db.select({
    conversationId: conversationMembers.conversationId,
    role: conversationMembers.role,
    lastReadAt: conversationMembers.lastReadAt,
    pinned: conversationMembers.pinned,
  })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, userId));

  if (memberOf.length === 0) {
    return c.json({ data: [] });
  }

  const convIds = memberOf.map(m => m.conversationId);

  const convs = await db.select()
    .from(conversations)
    .where(inArray(conversations.id, convIds))
    .orderBy(desc(conversations.updatedAt));

  // Batch: last message per conversation (DISTINCT ON avoids N+1)
  const lastMessages = await db.execute<{
    conversation_id: string;
    id: string;
    content: string | null;
    sender_id: string;
    type: string;
    seq: number;
    created_at: string;
  }>(sql`
    SELECT DISTINCT ON (conversation_id)
      conversation_id, id, content, sender_id, type, seq, created_at
    FROM messages
    WHERE conversation_id = ANY(${convIds})
    ORDER BY conversation_id, seq DESC
  `);

  const lastMessageMap = new Map(
    (lastMessages.rows ?? lastMessages).map((m: any) => [m.conversation_id, {
      id: m.id,
      content: m.content,
      senderId: m.sender_id,
      type: m.type,
      seq: Number(m.seq),
      createdAt: m.created_at,
    }])
  );

  // Batch: unread counts per conversation
  // Build a values list of (convId, lastReadAt) for conversations with a lastReadAt
  const readPairs = memberOf.filter(m => m.lastReadAt);
  const unreadMap = new Map<string, number>();

  if (readPairs.length > 0) {
    // Use a single query with CASE/SUM to count unreads across all conversations
    const unreadResults = await db.execute<{
      conversation_id: string;
      unread: number;
    }>(sql`
      SELECT m.conversation_id, count(*)::int AS unread
      FROM messages m
      INNER JOIN (
        SELECT unnest(${readPairs.map(p => p.conversationId)}::uuid[]) AS conv_id,
               unnest(${readPairs.map(p => p.lastReadAt!.toISOString())}::timestamptz[]) AS last_read
      ) AS r ON m.conversation_id = r.conv_id
      WHERE m.created_at > r.last_read
      GROUP BY m.conversation_id
    `);

    for (const row of (unreadResults.rows ?? unreadResults) as any[]) {
      unreadMap.set(row.conversation_id, row.unread);
    }
  }

  // Batch: all members for all conversations in one query
  const allMembers = await db.select({
    conversationId: conversationMembers.conversationId,
    userId: conversationMembers.userId,
    role: conversationMembers.role,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
    status: users.status,
  })
    .from(conversationMembers)
    .innerJoin(users, eq(conversationMembers.userId, users.id))
    .where(inArray(conversationMembers.conversationId, convIds));

  const membersMap = new Map<string, typeof allMembers>();
  for (const member of allMembers) {
    const list = membersMap.get(member.conversationId) ?? [];
    list.push(member);
    membersMap.set(member.conversationId, list);
  }

  // Assemble results
  const result = convs.map(conv => {
    const membership = memberOf.find(m => m.conversationId === conv.id)!;
    return {
      ...conv,
      members: membersMap.get(conv.id) ?? [],
      lastMessage: lastMessageMap.get(conv.id) ?? null,
      unreadCount: unreadMap.get(conv.id) ?? 0,
      pinned: membership.pinned,
      role: membership.role,
    };
  });

  return c.json({ data: result });
});

// POST /api/conversations — create conversation
conversationsRouter.post('/', validate(createConversationSchema), async (c) => {
  const userId = c.get('userId');
  const body = (c as any).get('validatedBody') as {
    type: string;
    name?: string;
    description?: string;
    memberIds: string[];
  };

  // For DMs, check if conversation already exists between these two users
  if (body.type === 'dm') {
    if (body.memberIds.length !== 1) {
      return c.json({ error: 'validation_error', message: 'DM must have exactly one other member' }, 400);
    }

    const otherUserId = body.memberIds[0];

    // Find existing DM
    const existingDms = await db.select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, userId));

    for (const dm of existingDms) {
      const [conv] = await db.select()
        .from(conversations)
        .where(and(eq(conversations.id, dm.conversationId), eq(conversations.type, 'dm')))
        .limit(1);

      if (conv) {
        const [otherMember] = await db.select()
          .from(conversationMembers)
          .where(and(
            eq(conversationMembers.conversationId, conv.id),
            eq(conversationMembers.userId, otherUserId)
          ))
          .limit(1);

        if (otherMember) {
          return c.json(conv);
        }
      }
    }
  }

  // Create conversation
  const [conv] = await db.insert(conversations).values({
    type: body.type,
    name: body.name || null,
    description: body.description || null,
    creatorId: userId,
  }).returning();

  // Add creator as owner
  await db.insert(conversationMembers).values({
    conversationId: conv.id,
    userId: userId,
    role: 'owner',
  });

  // Add other members
  for (const memberId of body.memberIds) {
    await db.insert(conversationMembers).values({
      conversationId: conv.id,
      userId: memberId,
      role: 'member',
    });

    // Notify new member via Redis
    redisPub.publish(`user:${memberId}`, JSON.stringify({
      type: 'conversation.created',
      data: conv,
    }));
  }

  logger.info({ conversationId: conv.id, type: body.type }, 'Conversation created');

  return c.json(conv, 201);
});

// GET /api/conversations/:id
conversationsRouter.get('/:id', async (c) => {
  const userId = c.get('userId');
  const convId = c.req.param('id');

  // Check membership
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership) {
    return c.json({ error: 'forbidden', message: 'You are not a member of this conversation' }, 403);
  }

  const [conv] = await db.select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);

  if (!conv) {
    return c.json({ error: 'not_found', message: 'Conversation not found' }, 404);
  }

  // Get members
  const members = await db.select({
    userId: conversationMembers.userId,
    role: conversationMembers.role,
    joinedAt: conversationMembers.joinedAt,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
    status: users.status,
  })
    .from(conversationMembers)
    .innerJoin(users, eq(conversationMembers.userId, users.id))
    .where(eq(conversationMembers.conversationId, convId));

  return c.json({ ...conv, members });
});

// PATCH /api/conversations/:id
conversationsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const convId = c.req.param('id');

  // Check admin/owner
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return c.json({ error: 'forbidden', message: 'Only admins can update conversations' }, 403);
  }

  const body = await c.req.json();
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.settings !== undefined) updateData.settings = body.settings;

  const [updated] = await db.update(conversations)
    .set(updateData)
    .where(eq(conversations.id, convId))
    .returning();

  // Notify members
  redisPub.publish(`conv:${convId}`, JSON.stringify({
    type: 'conversation.updated',
    data: { id: convId, ...updateData },
  }));

  return c.json(updated);
});

// DELETE /api/conversations/:id
conversationsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const convId = c.req.param('id');

  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership || membership.role !== 'owner') {
    return c.json({ error: 'forbidden', message: 'Only the owner can delete conversations' }, 403);
  }

  await db.delete(conversations).where(eq(conversations.id, convId));

  return c.json({ message: 'Conversation deleted' });
});

// POST /api/conversations/:id/members — add member
conversationsRouter.post('/:id/members', validate(addMemberSchema), async (c) => {
  const userId = c.get('userId');
  const convId = c.req.param('id');
  const body = (c as any).get('validatedBody') as { userId: string; role: string };

  // Check admin/owner
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return c.json({ error: 'forbidden', message: 'Only admins can add members' }, 403);
  }

  // Check if already a member
  const [existing] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, body.userId)
    ))
    .limit(1);

  if (existing) {
    return c.json({ error: 'conflict', message: 'User is already a member' }, 409);
  }

  await db.insert(conversationMembers).values({
    conversationId: convId,
    userId: body.userId,
    role: body.role,
  });

  redisPub.publish(`conv:${convId}`, JSON.stringify({
    type: 'member.joined',
    data: { conversationId: convId, userId: body.userId, role: body.role },
  }));

  redisPub.publish(`user:${body.userId}`, JSON.stringify({
    type: 'conversation.created',
    data: { id: convId },
  }));

  return c.json({ message: 'Member added' }, 201);
});

// DELETE /api/conversations/:id/members/:userId — remove member
conversationsRouter.delete('/:id/members/:userId', async (c) => {
  const currentUserId = c.get('userId');
  const convId = c.req.param('id');
  const targetUserId = c.req.param('userId');

  // Allow self-removal (leaving) or admin removal
  if (currentUserId !== targetUserId) {
    const [membership] = await db.select()
      .from(conversationMembers)
      .where(and(
        eq(conversationMembers.conversationId, convId),
        eq(conversationMembers.userId, currentUserId)
      ))
      .limit(1);

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return c.json({ error: 'forbidden', message: 'Only admins can remove members' }, 403);
    }
  }

  await db.delete(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, convId),
      eq(conversationMembers.userId, targetUserId)
    ));

  redisPub.publish(`conv:${convId}`, JSON.stringify({
    type: 'member.left',
    data: { conversationId: convId, userId: targetUserId },
  }));

  return c.json({ message: 'Member removed' });
});

export default conversationsRouter;
