import { redis, redisPub } from './redis.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { logger } from './logger.js';

const PRESENCE_KEY = 'presence';

interface PresenceData {
  status: string;
  lastSeen: number;
  device: string;
}

export async function setUserOnline(userId: string) {
  const data: PresenceData = {
    status: 'online',
    lastSeen: Date.now(),
    device: 'web',
  };

  await redis.hset(PRESENCE_KEY, `user:${userId}`, JSON.stringify(data));

  await db.update(users)
    .set({ status: 'online', lastSeenAt: new Date() })
    .where(eq(users.id, userId));

  redisPub.publish(`presence:${userId}`, JSON.stringify({
    type: 'presence.update',
    data: { userId, status: 'online', lastSeenAt: new Date().toISOString() },
  }));

  logger.debug({ userId }, 'User online');
}

export async function setUserOffline(userId: string) {
  const now = new Date();
  const data: PresenceData = {
    status: 'offline',
    lastSeen: now.getTime(),
    device: 'web',
  };

  await redis.hset(PRESENCE_KEY, `user:${userId}`, JSON.stringify(data));

  await db.update(users)
    .set({ status: 'offline', lastSeenAt: now })
    .where(eq(users.id, userId));

  redisPub.publish(`presence:${userId}`, JSON.stringify({
    type: 'presence.update',
    data: { userId, status: 'offline', lastSeenAt: now.toISOString() },
  }));

  logger.debug({ userId }, 'User offline');
}

export async function getUserPresence(userId: string): Promise<PresenceData | null> {
  const raw = await redis.hget(PRESENCE_KEY, `user:${userId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function getOnlineUsers(): Promise<string[]> {
  const all = await redis.hgetall(PRESENCE_KEY);
  const online: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    const data: PresenceData = JSON.parse(value);
    if (data.status === 'online') {
      online.push(key.replace('user:', ''));
    }
  }

  return online;
}
