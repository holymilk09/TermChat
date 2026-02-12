import { Hono } from 'hono';
import { eq, ilike, or, and, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, updateUserSchema } from '../middleware/validate.js';

const usersRouter = new Hono();

// All routes require auth
usersRouter.use('*', authMiddleware);

// GET /api/users/me
usersRouter.get('/me', async (c) => {
  const userId = c.get('userId');

  const [user] = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    email: users.email,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
    status: users.status,
    lastSeenAt: users.lastSeenAt,
    settings: users.settings,
    createdAt: users.createdAt,
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ error: 'not_found', message: 'User not found' }, 404);
  }

  return c.json(user);
});

// PATCH /api/users/me
usersRouter.patch('/me', validate(updateUserSchema), async (c) => {
  const userId = c.get('userId');
  const body = (c as any).get('validatedBody') as { displayName?: string; avatarUrl?: string; settings?: Record<string, unknown> };

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.displayName !== undefined) updateData.displayName = body.displayName;
  if (body.avatarUrl !== undefined) updateData.avatarUrl = body.avatarUrl;
  if (body.settings !== undefined) updateData.settings = body.settings;

  const [updated] = await db.update(users)
    .set(updateData)
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      settings: users.settings,
      updatedAt: users.updatedAt,
    });

  return c.json(updated);
});

// GET /api/users/:id
usersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [user] = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
    status: users.status,
    lastSeenAt: users.lastSeenAt,
    createdAt: users.createdAt,
  })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'not_found', message: 'User not found' }, 404);
  }

  return c.json(user);
});

// GET /api/users/search?q=
usersRouter.get('/search', async (c) => {
  const query = c.req.query('q');
  const userId = c.get('userId');

  if (!query || query.length < 2) {
    return c.json({ error: 'validation_error', message: 'Search query must be at least 2 characters' }, 400);
  }

  const results = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isBot: users.isBot,
    status: users.status,
  })
    .from(users)
    .where(
      and(
        ne(users.id, userId),
        or(
          ilike(users.username, `%${query}%`),
          ilike(users.displayName, `%${query}%`)
        )
      )
    )
    .limit(20);

  return c.json({ data: results });
});

export default usersRouter;
