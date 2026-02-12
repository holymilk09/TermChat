import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { logger } from './services/logger.js';
import { setupWebSocketServer } from './ws/server.js';

// Routes
import auth from './routes/auth.js';
import usersRouter from './routes/users.js';
import conversationsRouter from './routes/conversations.js';
import messagesRouter from './routes/messages.js';
import uploadRouter from './routes/upload.js';
import searchRouter from './routes/search.js';
import botsRouter from './routes/bots.js';
import agentsRouter from './routes/agents.js';

// Services
import { openclawBridge } from './services/openclaw.js';

// Jobs
import { setupCronJobs } from './jobs/cron.js';
import { startWebhookWorker } from './jobs/webhook-deliver.js';
import { startCleanupWorker } from './jobs/cleanup.js';
import { closeQueues } from './jobs/queue.js';

const app = new Hono();

// Global middleware
app.use('*', cors({
  origin: config.isDev ? '*' : [],
  credentials: true,
}));

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// API routes
app.route('/api/auth', auth);
app.route('/api/users', usersRouter);
app.route('/api/conversations', conversationsRouter);
app.route('/api/messages', messagesRouter);
app.route('/api/upload', uploadRouter);
app.route('/api/search', searchRouter);
app.route('/api/bots', botsRouter);
app.route('/api/agents', agentsRouter);

// 404 handler
app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found' }, 404));

// Error handler
app.onError((err, c) => {
  logger.error({ err }, 'Unhandled error');
  return c.json({ error: 'internal_error', message: 'An internal error occurred' }, 500);
});

// Start server
const server = serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
}, (info) => {
  logger.info({ port: info.port, host: config.host }, 'TermChat server started');
});

// Setup WebSocket server on the same HTTP server
setupWebSocketServer(server as any);

// Start background services
async function startBackgroundServices() {
  // Start job workers
  startWebhookWorker(config.redisUrl);
  startCleanupWorker(config.redisUrl);

  // Setup scheduled jobs
  await setupCronJobs();

  // Connect to OpenClaw Gateway (non-blocking, will reconnect)
  openclawBridge.connect().catch(err => {
    logger.warn({ err }, 'OpenClaw Gateway not available (will retry)');
  });

  logger.info('Background services started');
}

startBackgroundServices().catch(err => {
  logger.error({ err }, 'Failed to start background services');
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down...');

  await openclawBridge.disconnect();
  await closeQueues();

  const { redis, redisSub, redisPub } = await import('./services/redis.js');
  await redis.quit();
  await redisSub.quit();
  await redisPub.quit();

  const { pool } = await import('./db/index.js');
  await pool.end();

  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
