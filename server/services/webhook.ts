import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { webhooks } from '../db/schema.js';
import { logger } from './logger.js';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 15000]; // Exponential backoff
const WEBHOOK_TIMEOUT = 10000; // 10 seconds

interface WebhookPayload {
  event: string;
  data: unknown;
  timestamp: number;
}

function signPayload(payload: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

export async function deliverWebhook(
  botUserId: string,
  event: string,
  data: unknown,
): Promise<void> {
  // Get active webhooks for this bot that listen to this event
  const hooks = await db.select()
    .from(webhooks)
    .where(and(
      eq(webhooks.botUserId, botUserId),
      eq(webhooks.active, true),
    ));

  for (const hook of hooks) {
    // Check if this webhook is subscribed to this event
    if (hook.events && !hook.events.includes(event) && !hook.events.includes('*')) {
      continue;
    }

    // Deliver with retries
    deliverWithRetry(hook, event, data, 0).catch(err => {
      logger.error({ err, webhookId: hook.id, event }, 'Webhook delivery failed permanently');
    });
  }
}

async function deliverWithRetry(
  hook: typeof webhooks.$inferSelect,
  event: string,
  data: unknown,
  attempt: number,
): Promise<void> {
  const payload: WebhookPayload = {
    event,
    data,
    timestamp: Date.now(),
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-TermChat-Event': event,
    'X-TermChat-Delivery': crypto.randomUUID(),
  };

  if (hook.secret) {
    headers['X-Signature-256'] = `sha256=${signPayload(body, hook.secret)}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

    const response = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      // Reset failure count on success
      await db.update(webhooks)
        .set({ failureCount: 0, lastSuccessAt: new Date() })
        .where(eq(webhooks.id, hook.id));

      logger.debug({ webhookId: hook.id, event, status: response.status }, 'Webhook delivered');
      return;
    }

    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  } catch (err) {
    logger.warn({
      webhookId: hook.id,
      event,
      attempt: attempt + 1,
      err: err instanceof Error ? err.message : 'Unknown error',
    }, 'Webhook delivery attempt failed');

    // Update failure tracking
    const newFailureCount = (hook.failureCount || 0) + 1;
    await db.update(webhooks)
      .set({
        failureCount: newFailureCount,
        lastFailureAt: new Date(),
        // Disable webhook after too many consecutive failures
        active: newFailureCount < 100,
      })
      .where(eq(webhooks.id, hook.id));

    // Retry if we haven't exceeded max retries
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS[attempt] || 15000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return deliverWithRetry(hook, event, data, attempt + 1);
    }
  }
}
