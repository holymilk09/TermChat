import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agents, agentSessions, agentTasks, users } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { redisPub } from '../services/redis.js';
import { logger } from '../services/logger.js';

const agentsRouter = new Hono();

agentsRouter.use('*', authMiddleware);

// GET /api/agents — list user's agents
agentsRouter.get('/', async (c) => {
  const userId = c.get('userId');

  const result = await db.select()
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(desc(agents.createdAt));

  return c.json({ data: result });
});

// POST /api/agents — create agent
agentsRouter.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();

  if (!body.slug || !body.name || !body.model) {
    return c.json({ error: 'validation_error', message: 'slug, name, and model are required' }, 400);
  }

  // Check slug uniqueness
  const [existing] = await db.select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, body.slug))
    .limit(1);

  if (existing) {
    return c.json({ error: 'conflict', message: 'Agent slug already taken' }, 409);
  }

  // Create bot user for the agent
  const [botUser] = await db.insert(users).values({
    username: `agent_${body.slug}`,
    displayName: body.name,
    isBot: true,
    botOwnerId: userId,
    status: 'offline',
  }).returning();

  const [agent] = await db.insert(agents).values({
    botUserId: botUser.id,
    ownerId: userId,
    slug: body.slug,
    name: body.name,
    icon: body.icon || null,
    model: body.model,
    fallbackModels: body.fallbackModels || [],
    scopes: body.scopes || ['read'],
    skills: body.skills || [],
    sandbox: body.sandbox || 'all',
    heartbeat: body.heartbeat || null,
    workspace: body.workspace || null,
    systemPrompt: body.systemPrompt || null,
    config: body.config || {},
    isPrimary: body.isPrimary || false,
    parentId: body.parentId || null,
  }).returning();

  logger.info({ agentId: agent.id, slug: body.slug }, 'Agent created');

  return c.json(agent, 201);
});

// GET /api/agents/:id
agentsRouter.get('/:id', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');

  const [agent] = await db.select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  return c.json(agent);
});

// PATCH /api/agents/:id
agentsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');
  const body = await c.req.json();

  const [agent] = await db.select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  const allowedFields = [
    'name', 'icon', 'model', 'fallbackModels', 'scopes', 'skills',
    'sandbox', 'heartbeat', 'workspace', 'systemPrompt', 'config',
    'state', 'isPrimary',
  ];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updateData[field] = body[field];
    }
  }

  const [updated] = await db.update(agents)
    .set(updateData)
    .where(eq(agents.id, agentId))
    .returning();

  // Broadcast state change if applicable
  if (body.state) {
    redisPub.publish(`agent:${agentId}`, JSON.stringify({
      type: 'agent.state',
      data: { agentId, state: body.state },
    }));
  }

  return c.json(updated);
});

// DELETE /api/agents/:id
agentsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');

  const [agent] = await db.select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // Delete the agent's bot user too
  if (agent.botUserId) {
    await db.delete(users).where(eq(users.id, agent.botUserId));
  }

  await db.delete(agents).where(eq(agents.id, agentId));

  logger.info({ agentId }, 'Agent deleted');
  return c.json({ message: 'Agent deleted' });
});

// GET /api/agents/:id/tasks — agent task history
agentsRouter.get('/:id/tasks', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const status = c.req.query('status');

  // Verify ownership
  const [agent] = await db.select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const conditions = [eq(agentTasks.agentId, agentId)];
  if (status) {
    conditions.push(eq(agentTasks.status, status));
  }

  const tasks = await db.select()
    .from(agentTasks)
    .where(and(...conditions))
    .orderBy(desc(agentTasks.createdAt))
    .limit(limit);

  return c.json({ data: tasks });
});

// GET /api/agents/:id/sessions — agent session history
agentsRouter.get('/:id/sessions', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);

  const [agent] = await db.select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const sessions = await db.select()
    .from(agentSessions)
    .where(eq(agentSessions.agentId, agentId))
    .orderBy(desc(agentSessions.startedAt))
    .limit(limit);

  return c.json({ data: sessions });
});

// POST /api/agents/:id/command — send command to agent
agentsRouter.post('/:id/command', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');
  const body = await c.req.json();

  const [agent] = await db.select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const { command } = body;
  if (!command) {
    return c.json({ error: 'validation_error', message: 'command is required' }, 400);
  }

  let newState = agent.state;

  switch (command) {
    case '/pause':
      newState = 'paused';
      break;
    case '/resume':
      newState = 'idle';
      break;
    case '/status':
      return c.json({
        agentId: agent.id,
        slug: agent.slug,
        state: agent.state,
        model: agent.model,
      });
    default:
      return c.json({ error: 'validation_error', message: `Unknown command: ${command}` }, 400);
  }

  await db.update(agents)
    .set({ state: newState, updatedAt: new Date() })
    .where(eq(agents.id, agentId));

  redisPub.publish(`agent:${agentId}`, JSON.stringify({
    type: 'agent.state',
    data: { agentId, state: newState },
  }));

  logger.info({ agentId, command, newState }, 'Agent command executed');

  return c.json({ agentId, state: newState, command });
});

// GET /api/agents/:id/cost — cost summary
agentsRouter.get('/:id/cost', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');

  const [agent] = await db.select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const [costSummary] = await db.select({
    totalSessions: sql<number>`count(*)::int`,
    totalTokens: sql<number>`COALESCE(sum(${agentSessions.tokensUsed}), 0)::int`,
    totalCostUsd: sql<string>`COALESCE(sum(${agentSessions.costUsd}), 0)::decimal(10,4)`,
  })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, agentId));

  return c.json(costSummary);
});

export default agentsRouter;
