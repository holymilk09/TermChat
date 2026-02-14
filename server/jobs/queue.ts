import { Queue, Worker, QueueEvents } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

// Parse Redis URL for BullMQ connection
export function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
    password: parsed.password || undefined,
  };
}

const connection = parseRedisUrl(config.redisUrl);

// ── Queues ──────────────────────────────────────

export const webhookQueue = new Queue('webhook-delivery', { connection });
export const cleanupQueue = new Queue('cleanup', { connection });
export const cronQueue = new Queue('cron-jobs', { connection });

// ── Queue Events (for monitoring) ───────────────

export function setupQueueMonitoring() {
  const webhookEvents = new QueueEvents('webhook-delivery', { connection });
  webhookEvents.on('completed', ({ jobId }) => {
    logger.debug({ jobId }, 'Webhook delivery completed');
  });
  webhookEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'Webhook delivery failed');
  });

  const cleanupEvents = new QueueEvents('cleanup', { connection });
  cleanupEvents.on('completed', ({ jobId }) => {
    logger.debug({ jobId }, 'Cleanup job completed');
  });

  return { webhookEvents, cleanupEvents };
}

// ── Graceful shutdown ───────────────────────────

export async function closeQueues() {
  await webhookQueue.close();
  await cleanupQueue.close();
  await cronQueue.close();
}
