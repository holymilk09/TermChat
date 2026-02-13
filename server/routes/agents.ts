import { Hono } from 'hono';
import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agents, agentSessions, agentTasks, agentTokens, users, conversations, conversationMembers } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { redisPub } from '../services/redis.js';
import { logger } from '../services/logger.js';
import { liveActivityService } from '../services/live-activity.js';

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

// GET /api/agents/activities — active live activities for the current user
// Mobile clients call this on launch / reconnect to restore Dynamic Island / notification state
agentsRouter.get('/activities', async (c) => {
  const userId = c.get('userId');
  const activities = await liveActivityService.getForUser(userId);
  return c.json({ data: activities });
});

// GET /api/agents/activities/:activityId — a specific live activity
agentsRouter.get('/activities/:activityId', async (c) => {
  const activityId = c.req.param('activityId');
  const activity = await liveActivityService.get(activityId);

  if (!activity) {
    return c.json({ error: 'not_found', message: 'Activity not found or expired' }, 404);
  }

  return c.json(activity);
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

// POST /api/agents/:id/setup — full onboarding: create conversation + return instructions
agentsRouter.post('/:id/setup', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');

  const [agent] = await db.select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // FIX: Guard against null botUserId
  if (!agent.botUserId) {
    return c.json({ error: 'bad_state', message: 'Agent has no bot user configured' }, 500);
  }

  const botUserId = agent.botUserId;

  // FIX: Find existing agent conversation where the bot is a member
  const existingConvs = await db.select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .innerJoin(conversations, and(
      eq(conversations.id, conversationMembers.conversationId),
      eq(conversations.type, 'agent'),
    ))
    .where(eq(conversationMembers.userId, botUserId))
    .limit(1);

  let conversationId: string;

  if (existingConvs.length > 0) {
    conversationId = existingConvs[0].conversationId;
  } else {
    // FIX: Wrap in transaction to prevent orphaned conversation
    const conv = await db.transaction(async (tx) => {
      const [newConv] = await tx.insert(conversations).values({
        type: 'agent',
        name: agent.name,
        creatorId: userId,
      }).returning();

      await tx.insert(conversationMembers).values([
        { conversationId: newConv.id, userId, role: 'owner' },
        { conversationId: newConv.id, userId: botUserId, role: 'bot' },
      ]);

      return newConv;
    });

    conversationId = conv.id;
  }

  logger.info({ agentId, conversationId }, 'Agent setup completed');

  return c.json({
    agent: {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      model: agent.model,
      state: agent.state,
    },
    conversationId,
    connectInstructions: {
      appFirst: 'Generate a pairing code via POST /api/pairing/generate',
      terminalFirst: 'Run: npx termchat-agent init',
      cliLink: 'Run: npx termchat-agent link <CODE>',
    },
  });
});

// GET /api/agents/:id/tokens — list active tokens for an agent
agentsRouter.get('/:id/tokens', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');

  const [agent] = await db.select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const tokens = await db.select({
    id: agentTokens.id,
    name: agentTokens.name,
    lastUsedAt: agentTokens.lastUsedAt,
    createdAt: agentTokens.createdAt,
  })
    .from(agentTokens)
    .where(and(
      eq(agentTokens.agentId, agentId),
      isNull(agentTokens.revokedAt),
    ))
    .orderBy(desc(agentTokens.createdAt));

  return c.json({ data: tokens });
});

// DELETE /api/agents/:id/tokens/:tokenId — revoke a specific token
agentsRouter.delete('/:id/tokens/:tokenId', async (c) => {
  const userId = c.get('userId');
  const agentId = c.req.param('id');
  const tokenId = c.req.param('tokenId');

  const [agent] = await db.select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const [token] = await db.select({ id: agentTokens.id })
    .from(agentTokens)
    .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.agentId, agentId)))
    .limit(1);

  if (!token) {
    return c.json({ error: 'not_found', message: 'Token not found' }, 404);
  }

  await db.update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(eq(agentTokens.id, tokenId));

  logger.info({ agentId, tokenId }, 'Agent token revoked from agent route');

  return c.json({ message: 'Token revoked' });
});

export default agentsRouter;
