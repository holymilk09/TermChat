import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { generateAccessToken, generateRefreshToken, authMiddleware } from '../middleware/auth.js';
import { validate, registerSchema, loginSchema } from '../middleware/validate.js';
import { authRateLimit } from '../middleware/rate-limit.js';
import { redis } from '../services/redis.js';
import { logger } from '../services/logger.js';

const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60; // 30 days in seconds

const auth = new Hono();

// POST /api/auth/register
auth.post('/register', authRateLimit, validate(registerSchema), async (c) => {
  const body = (c as any).get('validatedBody') as { username: string; password: string; email?: string; displayName?: string };

  // Check if username exists
  const existing = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.username, body.username))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: 'conflict', message: 'Username already taken' }, 409);
  }

  // Check email uniqueness if provided
  if (body.email) {
    const emailExists = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (emailExists.length > 0) {
      return c.json({ error: 'conflict', message: 'Email already registered' }, 409);
    }
  }

  const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);

  const [user] = await db.insert(users).values({
    username: body.username,
    passwordHash,
    email: body.email || null,
    displayName: body.displayName || body.username,
  }).returning({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    isBot: users.isBot,
  });

  const accessToken = generateAccessToken({ id: user.id, username: user.username, isBot: user.isBot });
  const refreshToken = generateRefreshToken();

  // Store refresh token in Redis
  await redis.setex(`refresh:${refreshToken}`, REFRESH_TOKEN_EXPIRY, user.id);

  logger.info({ username: user.username }, 'User registered');

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    },
    accessToken,
    refreshToken,
  }, 201);
});

// POST /api/auth/login
auth.post('/login', authRateLimit, validate(loginSchema), async (c) => {
  const body = (c as any).get('validatedBody') as { username: string; password: string };

  const [user] = await db.select()
    .from(users)
    .where(eq(users.username, body.username))
    .limit(1);

  if (!user || !user.passwordHash) {
    return c.json({ error: 'unauthorized', message: 'Invalid username or password' }, 401);
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) {
    return c.json({ error: 'unauthorized', message: 'Invalid username or password' }, 401);
  }

  const accessToken = generateAccessToken({ id: user.id, username: user.username, isBot: user.isBot });
  const refreshToken = generateRefreshToken();

  await redis.setex(`refresh:${refreshToken}`, REFRESH_TOKEN_EXPIRY, user.id);

  // Update last seen
  await db.update(users)
    .set({ lastSeenAt: new Date(), status: 'online' })
    .where(eq(users.id, user.id));

  logger.info({ username: user.username }, 'User logged in');

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    },
    accessToken,
    refreshToken,
  });
});

// POST /api/auth/refresh
auth.post('/refresh', async (c) => {
  let body: { refreshToken: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'validation_error', message: 'Invalid JSON body' }, 400);
  }

  if (!body.refreshToken) {
    return c.json({ error: 'validation_error', message: 'refreshToken is required' }, 400);
  }

  const userId = await redis.get(`refresh:${body.refreshToken}`);
  if (!userId) {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired refresh token' }, 401);
  }

  // Revoke old token
  await redis.del(`refresh:${body.refreshToken}`);

  const [user] = await db.select({
    id: users.id,
    username: users.username,
    isBot: users.isBot,
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ error: 'unauthorized', message: 'User not found' }, 401);
  }

  const accessToken = generateAccessToken(user);
  const newRefreshToken = generateRefreshToken();

  await redis.setex(`refresh:${newRefreshToken}`, REFRESH_TOKEN_EXPIRY, user.id);

  return c.json({ accessToken, refreshToken: newRefreshToken });
});

// POST /api/auth/logout
auth.post('/logout', authMiddleware, async (c) => {
  let body: { refreshToken?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // No body is fine
  }

  if (body.refreshToken) {
    await redis.del(`refresh:${body.refreshToken}`);
  }

  return c.json({ message: 'Logged out' });
});

export default auth;
