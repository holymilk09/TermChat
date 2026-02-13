import { cleanupQueue } from './queue.js';
import { logger } from '../services/logger.js';

export async function setupCronJobs() {
  // Clean up expired messages every hour
  await cleanupQueue.add(
    'expired-messages',
    { type: 'expired_messages' },
    {
      repeat: { pattern: '0 * * * *' }, // Every hour
      removeOnComplete: 10,
      removeOnFail: 50,
    }
  );

  // Clean up stale agent sessions every 6 hours
  await cleanupQueue.add(
    'stale-sessions',
    { type: 'stale_sessions' },
    {
      repeat: { pattern: '0 */6 * * *' }, // Every 6 hours
      removeOnComplete: 10,
      removeOnFail: 50,
    }
  );

  // Clean up expired pairing codes and device auth requests every 4 hours
  await cleanupQueue.add(
    'expired-pairing',
    { type: 'expired_pairing' },
    {
      repeat: { pattern: '0 */4 * * *' }, // Every 4 hours
      removeOnComplete: 10,
      removeOnFail: 50,
    }
  );

  logger.info('Cron jobs scheduled');
}
