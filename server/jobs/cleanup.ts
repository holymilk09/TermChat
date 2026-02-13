import { Worker, Job } from 'bullmq';
import { lt, eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, agentSessions, pairingCodes, deviceAuthRequests } from '../db/schema.js';
import { logger } from '../services/logger.js';

interface CleanupJobData {
  type: 'expired_messages' | 'stale_sessions' | 'old_messages' | 'expired_pairing';
}

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
    password: parsed.password || undefined,
  };
}

export function startCleanupWorker(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<CleanupJobData>(
    'cleanup',
    async (job: Job<CleanupJobData>) => {
      switch (job.data.type) {
        case 'expired_messages':
          return await cleanupExpiredMessages();
        case 'stale_sessions':
          return await cleanupStaleSessions();
        case 'expired_pairing':
          return await cleanupExpiredPairing();
        default:
          logger.warn({ type: job.data.type }, 'Unknown cleanup job type');
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Cleanup job failed');
  });

  logger.info('Cleanup worker started');
  return worker;
}

async function cleanupExpiredMessages(): Promise<{ deleted: number }> {
  const now = new Date();

  // Delete messages past their expiry
  const result = await db.delete(messages)
    .where(and(
      sql`${messages.expiresAt} IS NOT NULL`,
      lt(messages.expiresAt, now)
    ))
    .returning({ id: messages.id });

  if (result.length > 0) {
    logger.info({ count: result.length }, 'Cleaned up expired messages');
  }

  return { deleted: result.length };
}

async function cleanupStaleSessions(): Promise<{ cleaned: number }> {
  // Mark sessions older than 24h as failed if still active
  const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await db.update(agentSessions)
    .set({ state: 'failed', endedAt: new Date() })
    .where(and(
      eq(agentSessions.state, 'active'),
      lt(agentSessions.startedAt, staleTime)
    ))
    .returning({ id: agentSessions.id });

  if (result.length > 0) {
    logger.info({ count: result.length }, 'Cleaned up stale agent sessions');
  }

  return { cleaned: result.length };
}

async function cleanupExpiredPairing(): Promise<{ pairingCleaned: number; deviceAuthCleaned: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h old

  // Delete expired pairing codes older than 24h
  const pairingResult = await db.delete(pairingCodes)
    .where(and(
      lt(pairingCodes.expiresAt, cutoff),
      sql`${pairingCodes.status} != 'exchanged'`
    ))
    .returning({ id: pairingCodes.id });

  // Delete expired/denied device auth requests older than 24h
  const deviceResult = await db.delete(deviceAuthRequests)
    .where(and(
      lt(deviceAuthRequests.expiresAt, cutoff),
      sql`${deviceAuthRequests.status} IN ('pending', 'denied', 'expired')`
    ))
    .returning({ id: deviceAuthRequests.id });

  if (pairingResult.length > 0 || deviceResult.length > 0) {
    logger.info(
      { pairingCodes: pairingResult.length, deviceAuth: deviceResult.length },
      'Cleaned up expired pairing data'
    );
  }

  return { pairingCleaned: pairingResult.length, deviceAuthCleaned: deviceResult.length };
}
