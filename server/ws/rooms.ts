import { redisSub, redisPub } from '../services/redis.js';
import { logger } from '../services/logger.js';
import type { WebSocket } from 'ws';

// Maps channel names to sets of WebSocket connections
const channelSubscribers = new Map<string, Set<WebSocket>>();
// Maps user IDs to their WebSocket connections
const userConnections = new Map<string, Set<WebSocket>>();
// Tracks which channels each WebSocket is subscribed to
const wsChannels = new Map<WebSocket, Set<string>>();

let redisSubInitialized = false;

function initRedisSubscriber() {
  if (redisSubInitialized) return;
  redisSubInitialized = true;

  redisSub.on('message', (channel, message) => {
    const subscribers = channelSubscribers.get(channel);
    if (!subscribers) return;

    for (const ws of subscribers) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  });
}

export function subscribeToChannel(ws: WebSocket, channel: string) {
  initRedisSubscriber();

  if (!channelSubscribers.has(channel)) {
    channelSubscribers.set(channel, new Set());
    redisSub.subscribe(channel).catch(err => {
      logger.error({ err, channel }, 'Failed to subscribe to Redis channel');
    });
  }

  channelSubscribers.get(channel)!.add(ws);

  if (!wsChannels.has(ws)) {
    wsChannels.set(ws, new Set());
  }
  wsChannels.get(ws)!.add(channel);
}

export function unsubscribeFromChannel(ws: WebSocket, channel: string) {
  const subscribers = channelSubscribers.get(channel);
  if (subscribers) {
    subscribers.delete(ws);
    if (subscribers.size === 0) {
      channelSubscribers.delete(channel);
      redisSub.unsubscribe(channel).catch(err => {
        logger.error({ err, channel }, 'Failed to unsubscribe from Redis channel');
      });
    }
  }

  const channels = wsChannels.get(ws);
  if (channels) {
    channels.delete(channel);
  }
}

export function cleanupConnection(ws: WebSocket) {
  const channels = wsChannels.get(ws);
  if (channels) {
    for (const channel of channels) {
      const subscribers = channelSubscribers.get(channel);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          channelSubscribers.delete(channel);
          redisSub.unsubscribe(channel).catch(() => {});
        }
      }
    }
    wsChannels.delete(ws);
  }
}

export function registerUserConnection(userId: string, ws: WebSocket) {
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(ws);

  // Subscribe to user's personal channel
  subscribeToChannel(ws, `user:${userId}`);
}

export function removeUserConnection(userId: string, ws: WebSocket) {
  const connections = userConnections.get(userId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      userConnections.delete(userId);
    }
  }
  cleanupConnection(ws);
}

export function isUserOnline(userId: string): boolean {
  const connections = userConnections.get(userId);
  return !!connections && connections.size > 0;
}

export function getOnlineUserCount(): number {
  return userConnections.size;
}

export function publishToChannel(channel: string, event: object) {
  redisPub.publish(channel, JSON.stringify(event));
}
