import { IncomingMessage } from 'http';
import { verifyToken, JwtPayload } from '../middleware/auth.js';
import { logger } from '../services/logger.js';

export interface AuthenticatedRequest extends IncomingMessage {
  userId?: string;
  username?: string;
  isBot?: boolean;
}

export function authenticateWsConnection(req: IncomingMessage): JwtPayload | null {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      logger.debug('WebSocket connection rejected: no token');
      return null;
    }

    const payload = verifyToken(token);
    return payload;
  } catch (err) {
    logger.debug('WebSocket connection rejected: invalid token');
    return null;
  }
}
