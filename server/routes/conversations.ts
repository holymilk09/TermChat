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

  // Get last message for each conversation
  const result = await Promise.all(convs.map(async (conv) => {
    const membership = memberOf.find(m => m.conversationId === conv.id)!;

    const [lastMessage] = await db.select({
      id: messages.id,
      content: messages.content,
      senderId: messages.senderId,
      type: messages.type,
      seq: messages.seq,
      createdAt: messages.createdAt,
    })
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.seq))
      .limit(1);

    // Get unread count
    let unreadCount = 0;
    if (membership.lastReadAt) {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conv.id),
            sql`${messages.createdAt} > ${membership.lastReadAt}`
          )
        );
      unreadCount = count;
    }

    // Get members
    const members = await db.select({
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
      .where(eq(conversationMembers.conversationId, conv.id));

    return {
      ...conv,
      members,
      lastMessage: lastMessage || null,
      unreadCount,
      pinned: membership.pinned,
      role: membership.role,
    };
  }));

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
