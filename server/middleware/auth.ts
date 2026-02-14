import { Context, Next } from 'hono';
import crypto from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtPayload {
  sub: string;
  username: string;
  isBot: boolean;
  iat: number;
  exp: number;
}

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    username: string;
    isBot: boolean;
    jwtPayload: JwtPayload;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized', message: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
    c.set('userId', payload.sub);
    c.set('username', payload.username);
    c.set('isBot', payload.isBot);
    c.set('jwtPayload', payload);
    await next();
  } catch {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired token' }, 401);
  }
}

export function generateAccessToken(user: { id: string; username: string; isBot: boolean }): string {
  const options: SignOptions = { expiresIn: config.jwt.accessExpiry as any };
  return jwt.sign(
    { sub: user.id, username: user.username, isBot: user.isBot },
    config.jwt.secret,
    options
  );
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwt.secret) as JwtPayload;
}
