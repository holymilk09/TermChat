import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { authenticateWsConnection } from './auth.js';
import { registerUserConnection, removeUserConnection, getOnlineUserCount } from './rooms.js';
import { handleClientEvent, subscribeUserToConversations } from './handlers.js';
import { setUserOnline, setUserOffline } from '../services/presence.js';
import { logger } from '../services/logger.js';
import type { ClientEvent } from '../../shared/types.js';

const HEARTBEAT_INTERVAL = 30000;
const CLIENT_TIMEOUT = 35000;

interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  userId: string;
  username: string;
}

export function setupWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Heartbeat to detect dead connections
  const interval = setInterval(() => {
    for (const client of wss.clients as Set<ExtendedWebSocket>) {
      if (!client.isAlive) {
        logger.debug({ userId: client.userId }, 'Terminating dead WebSocket connection');
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(interval);
  });

  wss.on('connection', async (ws: WebSocket, req) => {
    const extWs = ws as ExtendedWebSocket;

    // Authenticate
    const payload = authenticateWsConnection(req);
    if (!payload) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    extWs.isAlive = true;
    extWs.userId = payload.sub;
    extWs.username = payload.username;

    // Register connection
    registerUserConnection(payload.sub, ws);
    await setUserOnline(payload.sub);
    await subscribeUserToConversations(ws, payload.sub);

    logger.info({ userId: payload.sub, username: payload.username }, 'WebSocket connected');

    // Handle pong (heartbeat response)
    ws.on('pong', () => {
      extWs.isAlive = true;
    });

    // Handle incoming messages
    ws.on('message', async (data) => {
      try {
        const event: ClientEvent = JSON.parse(data.toString());
        await handleClientEvent(ws, payload.sub, payload.username, event);
      } catch (err) {
        logger.error({ err, userId: payload.sub }, 'Error handling WebSocket message');
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message format' } }));
      }
    });

    // Handle disconnect
    ws.on('close', async () => {
      removeUserConnection(payload.sub, ws);
      // Grace period before marking offline
      setTimeout(async () => {
        const { isUserOnline } = await import('./rooms.js');
        if (!isUserOnline(payload.sub)) {
          await setUserOffline(payload.sub);
        }
      }, 5000);
      logger.info({ userId: payload.sub }, 'WebSocket disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err, userId: payload.sub }, 'WebSocket error');
    });

    // Send initial state
    ws.send(JSON.stringify({
      type: 'connected',
      data: {
        userId: payload.sub,
        username: payload.username,
        onlineUsers: getOnlineUserCount(),
      },
    }));
  });

  logger.info('WebSocket server initialized on /ws');
  return wss;
}
