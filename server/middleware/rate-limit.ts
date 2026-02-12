import { Context, Next } from 'hono';
import { redis } from '../services/redis.js';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyPrefix } = options;
  const windowSec = Math.ceil(windowMs / 1000);

  return async (c: Context, next: Next) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const key = `ratelimit:${keyPrefix}:${ip}`;

    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec);
    }

    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, max - count)));

    if (count > max) {
      return c.json(
        { error: 'rate_limited', message: 'Too many requests, please try again later' },
        429
      );
    }

    await next();
  };
}

// Pre-configured rate limiters
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  keyPrefix: 'auth',
});

export const messageRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  keyPrefix: 'msg',
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyPrefix: 'api',
});
