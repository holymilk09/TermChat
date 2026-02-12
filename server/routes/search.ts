import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, users } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const searchRouter = new Hono();

searchRouter.use('*', authMiddleware);

// GET /api/search/messages?q=&conv_id=&limit=&offset=
searchRouter.get('/messages', async (c) => {
  const userId = c.get('userId');
  const query = c.req.query('q');
  const convId = c.req.query('conv_id');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);
  const offset = parseInt(c.req.query('offset') || '0');

  if (!query || query.length < 2) {
    return c.json({ error: 'validation_error', message: 'Search query must be at least 2 characters' }, 400);
  }

  // Build the search query using PostgreSQL full-text search
  // ts_query with plainto_tsquery for simple user input
  const tsQuery = sql`plainto_tsquery('english', ${query})`;

  // If conv_id is provided, search within that conversation (verify membership)
  if (convId) {
    const [membership] = await db.select()
      .from(conversationMembers)
      .where(and(
        eq(conversationMembers.conversationId, convId),
        eq(conversationMembers.userId, userId)
      ))
      .limit(1);

    if (!membership) {
      return c.json({ error: 'forbidden', message: 'Not a member of this conversation' }, 403);
    }

    const results = await db.select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      seq: messages.seq,
      type: messages.type,
      content: messages.content,
      createdAt: messages.createdAt,
      senderUsername: users.username,
      senderDisplayName: users.displayName,
      rank: sql<number>`ts_rank(to_tsvector('english', COALESCE(${messages.content}, '')), ${tsQuery})`,
    })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(and(
        eq(messages.conversationId, convId),
        sql`to_tsvector('english', COALESCE(${messages.content}, '')) @@ ${tsQuery}`,
        sql`${messages.deletedAt} IS NULL`
      ))
      .orderBy(sql`ts_rank(to_tsvector('english', COALESCE(${messages.content}, '')), ${tsQuery}) DESC`)
      .limit(limit)
      .offset(offset);

    return c.json({
      data: results.map(r => ({
        id: r.id,
        conversationId: r.conversationId,
        senderId: r.senderId,
        seq: r.seq,
        type: r.type,
        content: r.content,
        createdAt: r.createdAt,
        sender: {
          id: r.senderId,
          username: r.senderUsername,
          displayName: r.senderDisplayName,
        },
        rank: r.rank,
      })),
      query,
      hasMore: results.length === limit,
    });
  }

  // Search across all user's conversations
  const userConvs = await db.select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, userId));

  if (userConvs.length === 0) {
    return c.json({ data: [], query, hasMore: false });
  }

  const convIds = userConvs.map(c => c.conversationId);

  const results = await db.select({
    id: messages.id,
    conversationId: messages.conversationId,
    senderId: messages.senderId,
    seq: messages.seq,
    type: messages.type,
    content: messages.content,
    createdAt: messages.createdAt,
    senderUsername: users.username,
    senderDisplayName: users.displayName,
    rank: sql<number>`ts_rank(to_tsvector('english', COALESCE(${messages.content}, '')), ${tsQuery})`,
  })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(and(
      sql`${messages.conversationId} = ANY(${convIds})`,
      sql`to_tsvector('english', COALESCE(${messages.content}, '')) @@ ${tsQuery}`,
      sql`${messages.deletedAt} IS NULL`
    ))
    .orderBy(sql`ts_rank(to_tsvector('english', COALESCE(${messages.content}, '')), ${tsQuery}) DESC`)
    .limit(limit)
    .offset(offset);

  return c.json({
    data: results.map(r => ({
      id: r.id,
      conversationId: r.conversationId,
      senderId: r.senderId,
      seq: r.seq,
      type: r.type,
      content: r.content,
      createdAt: r.createdAt,
      sender: {
        id: r.senderId,
        username: r.senderUsername,
        displayName: r.senderDisplayName,
      },
      rank: r.rank,
    })),
    query,
    hasMore: results.length === limit,
  });
});

export default searchRouter;
