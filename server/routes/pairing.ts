import { Hono } from 'hono';
import { eq, and, gt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import {
  pairingCodes,
  agentTokens,
  deviceAuthRequests,
  agents,
  users,
  conversations,
  conversationMembers,
} from '../db/schema.js';
import { authMiddleware, generateAccessToken } from '../middleware/auth.js';
import { redis } from '../services/redis.js';
import { logger } from '../services/logger.js';

const pairingRouter = new Hono();

// ═══════════════════════════════════════════════════
// Pairing Code Flow (app-first)
// User creates agent in TermChat → gets code → enters in terminal
// ═══════════════════════════════════════════════════

// POST /api/pairing/generate — create a pairing code for an agent
pairingRouter.post('/generate', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const { agentId } = body;

  if (!agentId) {
    return c.json({ error: 'validation_error', message: 'agentId is required' }, 400);
  }

  // Verify agent ownership
  const [agent] = await db.select({ id: agents.id, name: agents.name, slug: agents.slug })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // Generate a short, human-readable code (e.g., AXRF-7KM2)
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Invalidate any existing pending codes for this agent
  await db.update(pairingCodes)
    .set({ status: 'expired' })
    .where(and(
      eq(pairingCodes.agentId, agentId),
      eq(pairingCodes.status, 'pending'),
    ));

  const [pairing] = await db.insert(pairingCodes).values({
    code,
    userId,
    agentId,
    status: 'pending',
    expiresAt,
  }).returning();

  logger.info({ agentId, code }, 'Pairing code generated');

  return c.json({
    code: pairing.code,
    agentId: agent.id,
    agentName: agent.name,
    agentSlug: agent.slug,
    expiresAt: pairing.expiresAt,
    expiresInSeconds: 600,
    instructions: `Run this on your server: npx openclaw link ${pairing.code}`,
  }, 201);
});

// POST /api/pairing/exchange — OpenClaw CLI exchanges code for a persistent token
// This endpoint does NOT require user auth — it's called from the terminal
pairingRouter.post('/exchange', async (c) => {
  const body = await c.req.json();
  const { code } = body;

  if (!code) {
    return c.json({ error: 'validation_error', message: 'code is required' }, 400);
  }

  // Find valid pairing code
  const [pairing] = await db.select()
    .from(pairingCodes)
    .where(and(
      eq(pairingCodes.code, code.toUpperCase()),
      eq(pairingCodes.status, 'pending'),
      gt(pairingCodes.expiresAt, new Date()),
    ))
    .limit(1);

  if (!pairing) {
    return c.json({ error: 'invalid_code', message: 'Pairing code is invalid, expired, or already used' }, 400);
  }

  if (!pairing.agentId) {
    return c.json({ error: 'invalid_code', message: 'No agent associated with this code' }, 400);
  }

  // Get agent details
  const [agent] = await db.select()
    .from(agents)
    .where(eq(agents.id, pairing.agentId))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent no longer exists' }, 404);
  }

  // Get owner info
  const [owner] = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
  })
    .from(users)
    .where(eq(users.id, pairing.userId))
    .limit(1);

  // Generate persistent agent token
  const rawToken = `agt_${nanoid(12)}_${nanoid(32)}`;
  const tokenHash = await bcrypt.hash(rawToken, 12);

  // Store token
  const [agentToken] = await db.insert(agentTokens).values({
    agentId: agent.id,
    tokenHash,
    name: body.deviceName || 'default',
  }).returning();

  // Mark pairing code as exchanged
  await db.update(pairingCodes)
    .set({
      status: 'exchanged',
      exchangedAt: new Date(),
      agentToken: agentToken.id,
      metadata: { deviceName: body.deviceName || null },
    })
    .where(eq(pairingCodes.id, pairing.id));

  // Update agent state to idle (connected)
  await db.update(agents)
    .set({ state: 'idle', updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  logger.info({ agentId: agent.id, code }, 'Pairing code exchanged for token');

  return c.json({
    token: rawToken,
    agent: {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      model: agent.model,
      scopes: agent.scopes,
      systemPrompt: agent.systemPrompt,
    },
    owner: {
      username: owner?.username,
      displayName: owner?.displayName,
    },
    gateway: {
      url: process.env.TERMCHAT_WS_URL || 'wss://api.termchat.app/ws/agent',
      protocol: 'termchat-agent-v1',
    },
    warning: 'Store this token securely. It will not be shown again.',
  });
});

// GET /api/pairing/:code/status — check code status (for polling from app)
pairingRouter.get('/:code/status', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const userId = c.get('userId');

  const [pairing] = await db.select()
    .from(pairingCodes)
    .where(and(
      eq(pairingCodes.code, code.toUpperCase()),
      eq(pairingCodes.userId, userId),
    ))
    .limit(1);

  if (!pairing) {
    return c.json({ error: 'not_found', message: 'Pairing code not found' }, 404);
  }

  const isExpired = new Date() > pairing.expiresAt;
  const effectiveStatus = isExpired && pairing.status === 'pending' ? 'expired' : pairing.status;

  return c.json({
    code: pairing.code,
    status: effectiveStatus,
    agentId: pairing.agentId,
    exchangedAt: pairing.exchangedAt,
    expiresAt: pairing.expiresAt,
  });
});

// ═══════════════════════════════════════════════════
// Device Auth Flow (terminal-first)
// User runs `openclaw init` → gets user_code → approves on phone
// Similar to GitHub CLI, Netflix TV login
// ═══════════════════════════════════════════════════

// POST /api/pairing/device/authorize — terminal requests a device auth flow
pairingRouter.post('/device/authorize', async (c) => {
  const body = await c.req.json();

  const userCode = generateUserCode();       // e.g., XK49-BETA
  const deviceCode = nanoid(64);              // long opaque string for polling
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  const [request] = await db.insert(deviceAuthRequests).values({
    userCode,
    deviceCode,
    status: 'pending',
    scopes: body.scopes || [],
    agentConfig: body.agentConfig || {},
    expiresAt,
  }).returning();

  logger.info({ userCode }, 'Device auth request created');

  return c.json({
    user_code: request.userCode,
    device_code: request.deviceCode,
    verification_url: `https://termchat.app/auth/device`,
    verification_url_complete: `https://termchat.app/auth/device?code=${request.userCode}`,
    expires_in: 900, // 15 minutes
    interval: 5,     // poll every 5 seconds
  });
});

// POST /api/pairing/device/approve — user approves from TermChat app
pairingRouter.post('/device/approve', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const { userCode, agentName, agentSlug, model } = body;

  if (!userCode) {
    return c.json({ error: 'validation_error', message: 'userCode is required' }, 400);
  }

  // Find pending request
  const [request] = await db.select()
    .from(deviceAuthRequests)
    .where(and(
      eq(deviceAuthRequests.userCode, userCode.toUpperCase()),
      eq(deviceAuthRequests.status, 'pending'),
      gt(deviceAuthRequests.expiresAt, new Date()),
    ))
    .limit(1);

  if (!request) {
    return c.json({ error: 'invalid_code', message: 'Device code is invalid, expired, or already used' }, 400);
  }

  // Create the agent (if terminal-first flow provided config)
  const slug = agentSlug || (request.agentConfig as any)?.slug || `agent-${nanoid(6)}`;
  const name = agentName || (request.agentConfig as any)?.name || slug;
  const agentModel = model || (request.agentConfig as any)?.model || 'claude-sonnet-4-5-20250929';

  // Check slug uniqueness
  const [existingAgent] = await db.select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, slug))
    .limit(1);

  if (existingAgent) {
    return c.json({ error: 'conflict', message: 'Agent slug already taken' }, 409);
  }

  // Create bot user
  const [botUser] = await db.insert(users).values({
    username: `agent_${slug}`,
    displayName: name,
    isBot: true,
    botOwnerId: userId,
    status: 'offline',
  }).returning();

  // Create agent
  const [agent] = await db.insert(agents).values({
    botUserId: botUser.id,
    ownerId: userId,
    slug,
    name,
    model: agentModel,
    scopes: (request.agentConfig as any)?.scopes || ['read', 'write'],
    systemPrompt: (request.agentConfig as any)?.systemPrompt || null,
  }).returning();

  // Create agent conversation
  const [conv] = await db.insert(conversations).values({
    type: 'agent',
    name,
    creatorId: userId,
  }).returning();

  await db.insert(conversationMembers).values([
    { conversationId: conv.id, userId, role: 'owner' },
    { conversationId: conv.id, userId: botUser.id, role: 'bot' },
  ]);

  // Approve the request
  await db.update(deviceAuthRequests)
    .set({
      status: 'approved',
      userId,
      agentId: agent.id,
      approvedAt: new Date(),
    })
    .where(eq(deviceAuthRequests.id, request.id));

  logger.info({ userId, agentId: agent.id, userCode }, 'Device auth approved');

  return c.json({
    status: 'approved',
    agent: {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
    },
    conversation: {
      id: conv.id,
    },
  });
});

// POST /api/pairing/device/deny — user denies from TermChat app
pairingRouter.post('/device/deny', authMiddleware, async (c) => {
  const body = await c.req.json();
  const { userCode } = body;

  if (!userCode) {
    return c.json({ error: 'validation_error', message: 'userCode is required' }, 400);
  }

  await db.update(deviceAuthRequests)
    .set({ status: 'denied' })
    .where(and(
      eq(deviceAuthRequests.userCode, userCode.toUpperCase()),
      eq(deviceAuthRequests.status, 'pending'),
    ));

  return c.json({ status: 'denied' });
});

// POST /api/pairing/device/token — terminal polls this to get token after approval
pairingRouter.post('/device/token', async (c) => {
  const body = await c.req.json();
  const { deviceCode } = body;

  if (!deviceCode) {
    return c.json({ error: 'validation_error', message: 'device_code is required' }, 400);
  }

  const [request] = await db.select()
    .from(deviceAuthRequests)
    .where(eq(deviceAuthRequests.deviceCode, deviceCode))
    .limit(1);

  if (!request) {
    return c.json({ error: 'invalid_request', message: 'Unknown device code' }, 400);
  }

  // Check expiry
  if (new Date() > request.expiresAt) {
    return c.json({ error: 'expired_token', message: 'Device code has expired' }, 400);
  }

  // Still waiting for user
  if (request.status === 'pending') {
    return c.json({ error: 'authorization_pending', message: 'User has not yet approved' }, 428);
  }

  // User denied
  if (request.status === 'denied') {
    return c.json({ error: 'access_denied', message: 'User denied the request' }, 403);
  }

  // Approved — generate agent token
  if (request.status === 'approved' && request.agentId) {
    const [agent] = await db.select()
      .from(agents)
      .where(eq(agents.id, request.agentId))
      .limit(1);

    if (!agent) {
      return c.json({ error: 'not_found', message: 'Agent no longer exists' }, 404);
    }

    // Generate persistent agent token
    const rawToken = `agt_${nanoid(12)}_${nanoid(32)}`;
    const tokenHash = await bcrypt.hash(rawToken, 12);

    await db.insert(agentTokens).values({
      agentId: agent.id,
      tokenHash,
      name: 'device-auth',
    });

    // Mark request as consumed (prevent re-use)
    await db.update(deviceAuthRequests)
      .set({ status: 'expired' })
      .where(eq(deviceAuthRequests.id, request.id));

    // Update agent online
    await db.update(agents)
      .set({ state: 'idle', updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    // Get owner info
    const [owner] = request.userId ? await db.select({
      username: users.username,
      displayName: users.displayName,
    })
      .from(users)
      .where(eq(users.id, request.userId))
      .limit(1) : [null];

    return c.json({
      token: rawToken,
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        model: agent.model,
        scopes: agent.scopes,
        systemPrompt: agent.systemPrompt,
      },
      owner: owner ? {
        username: owner.username,
        displayName: owner.displayName,
      } : null,
      gateway: {
        url: process.env.TERMCHAT_WS_URL || 'wss://api.termchat.app/ws/agent',
        protocol: 'termchat-agent-v1',
      },
      warning: 'Store this token securely. It will not be shown again.',
    });
  }

  return c.json({ error: 'invalid_request', message: 'Unexpected state' }, 400);
});

// ═══════════════════════════════════════════════════
// Agent Token Authentication
// Used by OpenClaw runtime to connect via WebSocket
// ═══════════════════════════════════════════════════

// POST /api/pairing/verify — verify an agent token (used by gateway)
pairingRouter.post('/verify', async (c) => {
  const body = await c.req.json();
  const { token } = body;

  if (!token || !token.startsWith('agt_')) {
    return c.json({ error: 'unauthorized', message: 'Invalid agent token' }, 401);
  }

  // Find matching token
  const tokens = await db.select()
    .from(agentTokens)
    .where(eq(agentTokens.revokedAt, null as any));

  for (const t of tokens) {
    if (await bcrypt.compare(token, t.tokenHash)) {
      // Update last used
      await db.update(agentTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentTokens.id, t.id));

      // Get agent
      const [agent] = await db.select()
        .from(agents)
        .where(eq(agents.id, t.agentId))
        .limit(1);

      if (!agent) {
        return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
      }

      return c.json({
        valid: true,
        agent: {
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          model: agent.model,
          ownerId: agent.ownerId,
        },
        tokenId: t.id,
      });
    }
  }

  return c.json({ error: 'unauthorized', message: 'Invalid agent token' }, 401);
});

// DELETE /api/pairing/tokens/:tokenId — revoke an agent token
pairingRouter.delete('/tokens/:tokenId', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const tokenId = c.req.param('tokenId');

  // Verify the token belongs to an agent owned by this user
  const [token] = await db.select({
    id: agentTokens.id,
    agentId: agentTokens.agentId,
  })
    .from(agentTokens)
    .innerJoin(agents, eq(agentTokens.agentId, agents.id))
    .where(and(
      eq(agentTokens.id, tokenId),
      eq(agents.ownerId, userId),
    ))
    .limit(1);

  if (!token) {
    return c.json({ error: 'not_found', message: 'Token not found' }, 404);
  }

  await db.update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(eq(agentTokens.id, tokenId));

  logger.info({ tokenId, agentId: token.agentId }, 'Agent token revoked');

  return c.json({ message: 'Token revoked' });
});

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════

function generatePairingCode(): string {
  // Generate format: XXXX-XXXX (alphanumeric, uppercase, no ambiguous chars)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += chars.charAt(Math.floor(Math.random() * chars.length));
    part2 += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${part1}-${part2}`;
}

function generateUserCode(): string {
  // Generate format: XXXX-XXXX (same as pairing but different namespace)
  return generatePairingCode();
}

export default pairingRouter;
