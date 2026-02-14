import { Worker, Job } from 'bullmq';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { webhooks } from '../db/schema.js';
import { logger } from '../services/logger.js';
import { parseRedisUrl } from './queue.js';

const WEBHOOK_TIMEOUT = 10000;

interface WebhookJobData {
  webhookId: string;
  url: string;
  secret: string | null;
  event: string;
  payload: unknown;
}

export function startWebhookWorker(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<WebhookJobData>(
    'webhook-delivery',
    async (job: Job<WebhookJobData>) => {
      const { webhookId, url, secret, event, payload } = job.data;

      const body = JSON.stringify({ event, data: payload, timestamp: Date.now() });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-TermChat-Event': event,
        'X-TermChat-Delivery': crypto.randomUUID(),
      };

      if (secret) {
        const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
        headers['X-Signature-256'] = `sha256=${sig}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        await db.update(webhooks)
          .set({ failureCount: 0, lastSuccessAt: new Date() })
          .where(eq(webhooks.id, webhookId));

        return { status: response.status };
      } catch (err) {
        clearTimeout(timeout);

        await db.update(webhooks)
          .set({
            failureCount: (job.attemptsMade || 0) + 1,
            lastFailureAt: new Date(),
          })
          .where(eq(webhooks.id, webhookId));

        throw err; // BullMQ will handle retries
      }
    },
    {
      connection,
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 60000, // 100 webhooks per minute
      },
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Webhook job failed');
  });

  logger.info('Webhook delivery worker started');
  return worker;
}
