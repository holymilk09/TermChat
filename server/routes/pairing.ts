import { Hono } from 'hono';
import { eq, and, gt, isNull } from 'drizzle-orm';
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
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { logger } from '../services/logger.js';

// Rate limiters for pairing endpoints
const pairingGenerateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'pair-gen' });
const pairingExchangeLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'pair-ex' });
const deviceAuthLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'dev-auth' });
const tokenVerifyLimit = rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: 'tok-verify' });
const devicePollLimit = rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: 'dev-poll' });

const pairingRouter = new Hono();

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;   // 15 minutes
const BCRYPT_ROUNDS = 12;

// ═══════════════════════════════════════════════════
// Pairing Code Flow (app-first)
// User creates agent in TermChat → gets code → enters in terminal
// ═══════════════════════════════════════════════════

// POST /api/pairing/generate — create a pairing code for an agent
pairingRouter.post('/generate', authMiddleware, pairingGenerateLimit, async (c) => {
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

  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

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

  logger.info({ agentId }, 'Pairing code generated');

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
pairingRouter.post('/exchange', pairingExchangeLimit, async (c) => {
  const body = await c.req.json();
  const { code } = body;

  if (!code || typeof code !== 'string') {
    return c.json({ error: 'validation_error', message: 'code is required' }, 400);
  }

  const normalizedCode = code.trim().toUpperCase();

  // Validate code format before touching the DB
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalizedCode)) {
    return c.json({ error: 'invalid_code', message: 'Pairing code is invalid, expired, or already used' }, 400);
  }

  const deviceName = typeof body.deviceName === 'string' ? body.deviceName.slice(0, 128) : 'default';

  // FIX: Atomic exchange — UPDATE ... WHERE status = 'pending' RETURNING
  // Only one request can claim a pending code (prevents race condition)
  const [claimed] = await db.update(pairingCodes)
    .set({
      status: 'exchanged',
      exchangedAt: new Date(),
      metadata: { deviceName },
    })
    .where(and(
      eq(pairingCodes.code, normalizedCode),
      eq(pairingCodes.status, 'pending'),
      gt(pairingCodes.expiresAt, new Date()),
    ))
    .returning();

  if (!claimed) {
    return c.json({ error: 'invalid_code', message: 'Pairing code is invalid, expired, or already used' }, 400);
  }

  if (!claimed.agentId) {
    return c.json({ error: 'invalid_code', message: 'No agent associated with this code' }, 400);
  }

  // Get agent details
  const [agent] = await db.select()
    .from(agents)
    .where(eq(agents.id, claimed.agentId))
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
    .where(eq(users.id, claimed.userId))
    .limit(1);

  // Generate persistent agent token
  const rawToken = `agt_${nanoid(12)}_${nanoid(32)}`;
  const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);

  // FIX: Wrap token creation + agent state update in transaction
  const agentToken = await db.transaction(async (tx) => {
    const [token] = await tx.insert(agentTokens).values({
      agentId: agent.id,
      tokenHash,
      name: deviceName,
    }).returning();

    await tx.update(pairingCodes)
      .set({ agentToken: token.id })
      .where(eq(pairingCodes.id, claimed.id));

    await tx.update(agents)
      .set({ state: 'idle', updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    return token;
  });

  logger.info({ agentId: agent.id }, 'Pairing code exchanged for token');

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
pairingRouter.post('/device/authorize', deviceAuthLimit, async (c) => {
  const body = await c.req.json();

  const userCode = generateUserCode();       // e.g., XK49-BETA
  const deviceCode = nanoid(64);              // long opaque string for polling
  const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_MS);

  // Validate agentConfig if provided
  const raw = body.agentConfig;
  const agentConfig = raw && typeof raw === 'object' && !Array.isArray(raw) ? {
    slug: typeof raw.slug === 'string' ? raw.slug.slice(0, 64) : undefined,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 128) : undefined,
    model: typeof raw.model === 'string' ? raw.model.slice(0, 256) : undefined,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s: unknown) => typeof s === 'string') : undefined,
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : undefined,
  } : {};

  const [request] = await db.insert(deviceAuthRequests).values({
    userCode,
    deviceCode,
    status: 'pending',
    scopes: body.scopes || [],
    agentConfig,
    expiresAt,
  }).returning();

  logger.info('Device auth request created');

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
// FIX: All writes wrapped in a transaction to prevent orphaned records
pairingRouter.post('/device/approve', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const { userCode, agentName, agentSlug, model } = body;

  if (!userCode || typeof userCode !== 'string') {
    return c.json({ error: 'validation_error', message: 'userCode is required' }, 400);
  }

  const normalizedCode = userCode.trim().toUpperCase();

  // Validate format before DB query
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalizedCode)) {
    return c.json({ error: 'invalid_code', message: 'Device code is invalid, expired, or already used' }, 400);
  }

  // Find pending request
  const [request] = await db.select()
    .from(deviceAuthRequests)
    .where(and(
      eq(deviceAuthRequests.userCode, normalizedCode),
      eq(deviceAuthRequests.status, 'pending'),
      gt(deviceAuthRequests.expiresAt, new Date()),
    ))
    .limit(1);

  if (!request) {
    return c.json({ error: 'invalid_code', message: 'Device code is invalid, expired, or already used' }, 400);
  }

  // Derive agent config
  const cfg = (request.agentConfig as Record<string, unknown>) || {};
  const slug = (typeof agentSlug === 'string' ? agentSlug : cfg.slug as string) || `agent-${nanoid(6)}`;
  const name = (typeof agentName === 'string' ? agentName : cfg.name as string) || slug;
  const agentModel = (typeof model === 'string' ? model : cfg.model as string) || 'claude-sonnet-4-5-20250929';

  // Validate slug format
  if (!isValidSlug(slug)) {
    return c.json({ error: 'validation_error', message: 'Slug must be 2-64 chars, lowercase alphanumeric and hyphens only' }, 400);
  }

  // FIX: All writes in a single transaction, including slug uniqueness check
  // This prevents the TOCTOU race where two requests both pass the check
  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Check slug uniqueness inside transaction
      const [existingAgent] = await tx.select({ id: agents.id })
        .from(agents)
        .where(eq(agents.slug, slug))
        .limit(1);

      if (existingAgent) {
        throw new SlugConflictError();
      }

      const [botUser] = await tx.insert(users).values({
        username: `agent_${slug}`,
        displayName: name,
        isBot: true,
        botOwnerId: userId,
        status: 'offline',
      }).returning();

      const [agent] = await tx.insert(agents).values({
        botUserId: botUser.id,
        ownerId: userId,
        slug,
        name,
        model: agentModel,
        scopes: (Array.isArray(cfg.scopes) ? cfg.scopes : ['read', 'write']) as string[],
        systemPrompt: typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : null,
      }).returning();

      const [conv] = await tx.insert(conversations).values({
        type: 'agent',
        name,
        creatorId: userId,
      }).returning();

      await tx.insert(conversationMembers).values([
        { conversationId: conv.id, userId, role: 'owner' },
        { conversationId: conv.id, userId: botUser.id, role: 'bot' },
      ]);

      await tx.update(deviceAuthRequests)
        .set({
          status: 'approved',
          userId,
          agentId: agent.id,
          approvedAt: new Date(),
        })
        .where(eq(deviceAuthRequests.id, request.id));

      return { agent, conv };
    });
  } catch (err) {
    if (err instanceof SlugConflictError) {
      return c.json({ error: 'conflict', message: 'Agent slug already taken' }, 409);
    }
    throw err;
  }

  logger.info({ userId, agentId: result.agent.id }, 'Device auth approved');

  return c.json({
    status: 'approved',
    agent: {
      id: result.agent.id,
      slug: result.agent.slug,
      name: result.agent.name,
    },
    conversation: {
      id: result.conv.id,
    },
  });
});

// POST /api/pairing/device/deny — user denies from TermChat app
pairingRouter.post('/device/deny', authMiddleware, async (c) => {
  const body = await c.req.json();
  const { userCode } = body;

  if (!userCode || typeof userCode !== 'string') {
    return c.json({ error: 'validation_error', message: 'userCode is required' }, 400);
  }

  await db.update(deviceAuthRequests)
    .set({ status: 'denied' })
    .where(and(
      eq(deviceAuthRequests.userCode, userCode.trim().toUpperCase()),
      eq(deviceAuthRequests.status, 'pending'),
    ));

  return c.json({ status: 'denied' });
});

// POST /api/pairing/device/token — terminal polls this to get token after approval
pairingRouter.post('/device/token', devicePollLimit, async (c) => {
  const body = await c.req.json();
  const { deviceCode } = body;

  if (!deviceCode || typeof deviceCode !== 'string') {
    return c.json({ error: 'validation_error', message: 'device_code is required' }, 400);
  }

  const [request] = await db.select()
    .from(deviceAuthRequests)
    .where(eq(deviceAuthRequests.deviceCode, deviceCode))
    .limit(1);

  if (!request) {
    return c.json({ error: 'invalid_request', message: 'Device code is invalid or expired' }, 400);
  }

  // Check expiry
  if (new Date() > request.expiresAt) {
    return c.json({ error: 'expired_token', message: 'Device code has expired' }, 400);
  }

  // Still waiting for user — 202 Accepted (standard for "processing")
  if (request.status === 'pending') {
    return c.json({ error: 'authorization_pending', message: 'User has not yet approved' }, 202);
  }

  // User denied
  if (request.status === 'denied') {
    return c.json({ error: 'access_denied', message: 'User denied the request' }, 403);
  }

  // Approved — generate agent token
  if (request.status === 'approved' && request.agentId) {
    // FIX: Atomic consume — UPDATE WHERE status='approved' prevents double-poll
    const [consumed] = await db.update(deviceAuthRequests)
      .set({ status: 'expired' })
      .where(and(
        eq(deviceAuthRequests.id, request.id),
        eq(deviceAuthRequests.status, 'approved'),
      ))
      .returning();

    if (!consumed) {
      return c.json({ error: 'invalid_request', message: 'Token already issued' }, 400);
    }

    const [agent] = await db.select()
      .from(agents)
      .where(eq(agents.id, request.agentId))
      .limit(1);

    if (!agent) {
      return c.json({ error: 'not_found', message: 'Agent no longer exists' }, 404);
    }

    const rawToken = `agt_${nanoid(12)}_${nanoid(32)}`;
    const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);

    await db.insert(agentTokens).values({
      agentId: agent.id,
      tokenHash,
      name: 'device-auth',
    });

    await db.update(agents)
      .set({ state: 'idle', updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

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
// FIX: Accept optional agentId to scope the bcrypt search and prevent DoS
pairingRouter.post('/verify', tokenVerifyLimit, async (c) => {
  const body = await c.req.json();
  const { token } = body;

  if (!token || typeof token !== 'string' || !token.startsWith('agt_')) {
    return c.json({ error: 'unauthorized', message: 'Invalid agent token' }, 401);
  }

  // Validate expected format: agt_{12}_{32}
  if (token.length < 40 || token.length > 60) {
    return c.json({ error: 'unauthorized', message: 'Invalid agent token' }, 401);
  }

  // Scope search by agentId if provided (reduces bcrypt comparisons)
  const conditions = [isNull(agentTokens.revokedAt)];
  if (body.agentId && typeof body.agentId === 'string') {
    conditions.push(eq(agentTokens.agentId, body.agentId));
  }

  const tokens = await db.select()
    .from(agentTokens)
    .where(and(...conditions));

  for (const t of tokens) {
    if (await bcrypt.compare(token, t.tokenHash)) {
      // Update last used
      await db.update(agentTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentTokens.id, t.id));

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

class SlugConflictError extends Error {
  constructor() { super('slug_conflict'); }
}

// Slug validation: 2-64 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphens
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

function isValidSlug(slug: string): boolean {
  if (slug.length < 2 || slug.length > 64) return false;
  if (slug.length === 2) return /^[a-z0-9]{2}$/.test(slug);
  return SLUG_REGEX.test(slug);
}

function generatePairingCode(): string {
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
  return generatePairingCode();
}

export default pairingRouter;
