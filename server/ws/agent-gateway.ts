import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import bcrypt from 'bcrypt';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  agentTokens,
  agents,
  agentSessions,
  agentTasks,
  conversationMembers,
} from '../db/schema.js';
import { redis, redisPub } from '../services/redis.js';
import { subscribeToChannel, publishToChannel, cleanupConnection } from './rooms.js';
import { logger } from '../services/logger.js';
import { liveActivityService } from '../services/live-activity.js';
import { createMessage } from '../services/message.js';

// ═══════════════════════════════════════════════════
// Agent WebSocket Gateway — /ws/agent
//
// After pairing, OpenClaw agents connect here with their
// agt_* token to send/receive messages in real time.
// ═══════════════════════════════════════════════════

const HEARTBEAT_INTERVAL = 30000;

interface AgentSocket extends WebSocket {
  isAlive: boolean;
  agentId: string;
  agentSlug: string;
  botUserId: string;
  tokenId: string;
  sessionId: string | null;
}

// Track connected agents: agentId → Set<AgentSocket>
const agentConnections = new Map<string, Set<AgentSocket>>();

// ── Agent Event Types ───────────────────────────

interface AgentMessageSend {
  type: 'message.send';
  data: {
    conversationId: string;
    content: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };
}

interface AgentTypingStart {
  type: 'typing.start';
  data: { conversationId: string };
}

interface AgentTypingStop {
  type: 'typing.stop';
  data: { conversationId: string };
}

interface AgentTaskUpdate {
  type: 'task.update';
  data: {
    taskId: string;
    status: string;
    output?: unknown;
  };
}

interface AgentTaskComplete {
  type: 'task.complete';
  data: {
    taskId: string;
    output?: unknown;
    tokensUsed?: number;
    costUsd?: number;
  };
}

interface AgentToolStart {
  type: 'tool.start';
  data: {
    conversationId: string;
    tool: string;
    input?: unknown;
  };
}

interface AgentToolEnd {
  type: 'tool.end';
  data: {
    conversationId: string;
    tool: string;
    output?: unknown;
    status: string;
  };
}

interface AgentStateUpdate {
  type: 'state.update';
  data: { state: 'idle' | 'working' | 'paused' | 'error' };
}

type AgentClientEvent =
  | AgentMessageSend
  | AgentTypingStart
  | AgentTypingStop
  | AgentTaskUpdate
  | AgentTaskComplete
  | AgentToolStart
  | AgentToolEnd
  | AgentStateUpdate;

// ── Setup ───────────────────────────────────────

export function setupAgentGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/agent' });

  // Heartbeat to detect dead agent connections
  const interval = setInterval(() => {
    for (const client of wss.clients as Set<AgentSocket>) {
      if (!client.isAlive) {
        logger.debug({ agentId: client.agentId }, 'Terminating dead agent connection');
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(interval);
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const agentWs = ws as AgentSocket;
    agentWs.isAlive = true;
    agentWs.sessionId = null;

    // ── Authenticate via agent token ──
    const authResult = await authenticateAgent(req);

    if (!authResult) {
      ws.close(4001, 'Unauthorized: invalid or revoked agent token');
      return;
    }

    agentWs.agentId = authResult.agentId;
    agentWs.agentSlug = authResult.slug;
    agentWs.botUserId = authResult.botUserId;
    agentWs.tokenId = authResult.tokenId;

    // Register connection
    registerAgentConnection(authResult.agentId, agentWs);

    // Update agent state and presence
    await db.update(agents)
      .set({ state: 'idle', updatedAt: new Date() })
      .where(eq(agents.id, authResult.agentId));

    await redis.hset('presence', `agent:${authResult.agentId}`, JSON.stringify({
      status: 'online',
      lastSeen: Date.now(),
    }));

    // Subscribe to agent's conversation channels
    const memberships = await db.select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, authResult.botUserId));

    const conversationIds: string[] = [];
    for (const m of memberships) {
      subscribeToChannel(ws, `conv:${m.conversationId}`);
      conversationIds.push(m.conversationId);
    }

    // Also subscribe to agent-specific channel for direct commands
    subscribeToChannel(ws, `agent:${authResult.agentId}`);

    // Update token last used
    await db.update(agentTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentTokens.id, authResult.tokenId));

    logger.info({ agentId: authResult.agentId, slug: authResult.slug }, 'Agent connected to gateway');

    // Broadcast agent online
    redisPub.publish(`agent:${authResult.agentId}`, JSON.stringify({
      type: 'agent.state',
      data: { agentId: authResult.agentId, state: 'idle' },
    }));

    // Send connected confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      data: {
        agentId: authResult.agentId,
        slug: authResult.slug,
        name: authResult.name,
        conversations: conversationIds,
        protocol: 'termchat-agent-v1',
      },
    }));

    // ── Heartbeat ──
    ws.on('pong', () => {
      agentWs.isAlive = true;
    });

    // ── Handle incoming events from agent ──
    ws.on('message', async (data) => {
      try {
        const event: AgentClientEvent = JSON.parse(data.toString());
        await handleAgentEvent(agentWs, event);
      } catch (err) {
        logger.error({ err, agentId: agentWs.agentId }, 'Error handling agent event');
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message format' } }));
      }
    });

    // ── Handle disconnect ──
    ws.on('close', async () => {
      removeAgentConnection(authResult.agentId, agentWs);
      cleanupConnection(ws);

      // Grace period before marking offline
      setTimeout(async () => {
        if (!isAgentOnline(authResult.agentId)) {
          await db.update(agents)
            .set({ state: 'idle', updatedAt: new Date() })
            .where(eq(agents.id, authResult.agentId));

          await redis.hdel('presence', `agent:${authResult.agentId}`);

          redisPub.publish(`agent:${authResult.agentId}`, JSON.stringify({
            type: 'agent.state',
            data: { agentId: authResult.agentId, state: 'idle' },
          }));

          // End any active sessions
          if (agentWs.sessionId) {
            await db.update(agentSessions)
              .set({ state: 'completed', endedAt: new Date() })
              .where(and(
                eq(agentSessions.id, agentWs.sessionId),
                eq(agentSessions.state, 'active'),
              ));

            liveActivityService.end(`la_${agentWs.sessionId}`, {
              state: 'completed',
              summary: 'Agent disconnected',
            }).catch(() => {});
          }
        }
      }, 5000);

      logger.info({ agentId: authResult.agentId }, 'Agent disconnected from gateway');
    });

    ws.on('error', (err) => {
      logger.error({ err, agentId: authResult.agentId }, 'Agent WebSocket error');
    });
  });

  logger.info('Agent WebSocket gateway initialized on /ws/agent');
  return wss;
}

// ── Authentication ──────────────────────────────

interface AgentAuthResult {
  agentId: string;
  slug: string;
  name: string;
  botUserId: string;
  tokenId: string;
}

async function authenticateAgent(req: IncomingMessage): Promise<AgentAuthResult | null> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token || !token.startsWith('agt_') || token.length < 40 || token.length > 60) {
      logger.debug('Agent WS rejected: invalid token format');
      return null;
    }

    // Find non-revoked tokens (scope by agentId if provided in query)
    const agentIdHint = url.searchParams.get('agent_id');
    const conditions = [isNull(agentTokens.revokedAt)];
    if (agentIdHint) {
      conditions.push(eq(agentTokens.agentId, agentIdHint));
    }

    const tokens = await db.select()
      .from(agentTokens)
      .where(and(...conditions));

    for (const t of tokens) {
      if (await bcrypt.compare(token, t.tokenHash)) {
        // Token matched — look up the agent
        const [agent] = await db.select({
          id: agents.id,
          slug: agents.slug,
          name: agents.name,
          botUserId: agents.botUserId,
        })
          .from(agents)
          .where(eq(agents.id, t.agentId))
          .limit(1);

        if (!agent || !agent.botUserId) {
          logger.debug({ agentId: t.agentId }, 'Agent WS rejected: agent not found or no bot user');
          return null;
        }

        return {
          agentId: agent.id,
          slug: agent.slug,
          name: agent.name,
          botUserId: agent.botUserId,
          tokenId: t.id,
        };
      }
    }

    logger.debug('Agent WS rejected: no matching token');
    return null;
  } catch (err) {
    logger.error({ err }, 'Agent authentication error');
    return null;
  }
}

// ── Connection Tracking ─────────────────────────

function registerAgentConnection(agentId: string, ws: AgentSocket) {
  if (!agentConnections.has(agentId)) {
    agentConnections.set(agentId, new Set());
  }
  agentConnections.get(agentId)!.add(ws);
}

function removeAgentConnection(agentId: string, ws: AgentSocket) {
  const connections = agentConnections.get(agentId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      agentConnections.delete(agentId);
    }
  }
}

export function isAgentOnline(agentId: string): boolean {
  const connections = agentConnections.get(agentId);
  return !!connections && connections.size > 0;
}

/** Send an event to a specific agent (all connections) */
export function sendToAgent(agentId: string, event: object): boolean {
  const connections = agentConnections.get(agentId);
  if (!connections || connections.size === 0) return false;

  const payload = JSON.stringify(event);
  for (const ws of connections) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
  return true;
}

// ── Event Handling ──────────────────────────────

async function handleAgentEvent(ws: AgentSocket, event: AgentClientEvent): Promise<void> {
  switch (event.type) {
    case 'message.send':
      await handleAgentMessage(ws, event.data);
      break;
    case 'typing.start':
      await handleAgentTyping(ws, event.data.conversationId, true);
      break;
    case 'typing.stop':
      await handleAgentTyping(ws, event.data.conversationId, false);
      break;
    case 'task.update':
      await handleTaskUpdate(ws, event.data);
      break;
    case 'task.complete':
      await handleTaskComplete(ws, event.data);
      break;
    case 'tool.start':
      await handleToolEvent(ws, 'agent.tool_start', event.data);
      break;
    case 'tool.end':
      await handleToolEvent(ws, 'agent.tool_end', event.data);
      break;
    case 'state.update':
      await handleStateUpdate(ws, event.data.state);
      break;
    default:
      logger.warn({ type: (event as any).type, agentId: ws.agentId }, 'Unknown agent event type');
  }
}

// ── Message from Agent ──────────────────────────

async function handleAgentMessage(
  ws: AgentSocket,
  data: { conversationId: string; content: string; type?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  // Verify agent is a member of this conversation
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, data.conversationId),
      eq(conversationMembers.userId, ws.botUserId),
    ))
    .limit(1);

  if (!membership) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Not a member of this conversation' } }));
    return;
  }

  // Clear typing indicator
  await redis.del(`typing:${data.conversationId}:${ws.botUserId}`);

  const message = await createMessage({
    conversationId: data.conversationId,
    senderId: ws.botUserId,
    content: data.content,
    type: data.type,
    metadata: data.metadata,
  });

  // Acknowledge to the agent
  ws.send(JSON.stringify({
    type: 'message.ack',
    data: { messageId: message.id, seq: message.seq },
  }));
}

// ── Typing Indicators ───────────────────────────

async function handleAgentTyping(ws: AgentSocket, conversationId: string, isStart: boolean): Promise<void> {
  if (isStart) {
    await redis.setex(`typing:${conversationId}:${ws.botUserId}`, 5, '1');
    publishToChannel(`conv:${conversationId}`, {
      type: 'typing.start',
      data: { conversationId, userId: ws.botUserId, username: ws.agentSlug },
    });
  } else {
    await redis.del(`typing:${conversationId}:${ws.botUserId}`);
    publishToChannel(`conv:${conversationId}`, {
      type: 'typing.stop',
      data: { conversationId, userId: ws.botUserId },
    });
  }
}

// ── Task Updates ────────────────────────────────

async function handleTaskUpdate(
  ws: AgentSocket,
  data: { taskId: string; status: string; output?: unknown }
): Promise<void> {
  const [task] = await db.select()
    .from(agentTasks)
    .where(and(
      eq(agentTasks.id, data.taskId),
      eq(agentTasks.agentId, ws.agentId),
    ))
    .limit(1);

  if (!task) return;

  await db.update(agentTasks)
    .set({
      status: data.status,
      output: data.output ? data.output as Record<string, unknown> : undefined,
      startedAt: data.status === 'running' && !task.startedAt ? new Date() : undefined,
    })
    .where(eq(agentTasks.id, data.taskId));

  if (task.conversationId) {
    publishToChannel(`conv:${task.conversationId}`, {
      type: 'agent.task_update',
      data: { taskId: data.taskId, agentId: ws.agentId, status: data.status },
    });
  }
}

async function handleTaskComplete(
  ws: AgentSocket,
  data: { taskId: string; output?: unknown; tokensUsed?: number; costUsd?: number }
): Promise<void> {
  const [task] = await db.select()
    .from(agentTasks)
    .where(and(
      eq(agentTasks.id, data.taskId),
      eq(agentTasks.agentId, ws.agentId),
    ))
    .limit(1);

  if (!task) return;

  await db.update(agentTasks)
    .set({
      status: 'completed',
      output: data.output ? data.output as Record<string, unknown> : undefined,
      cost: { tokensUsed: data.tokensUsed || 0, costUsd: data.costUsd || 0 },
      completedAt: new Date(),
    })
    .where(eq(agentTasks.id, data.taskId));

  // Capture sessionId before clearing it
  const completedSessionId = ws.sessionId;

  // End the session if this was the main task
  if (completedSessionId) {
    await db.update(agentSessions)
      .set({
        state: 'completed',
        endedAt: new Date(),
        tokensUsed: data.tokensUsed || 0,
        costUsd: String(data.costUsd || 0),
      })
      .where(eq(agentSessions.id, completedSessionId));

    liveActivityService.end(`la_${completedSessionId}`, {
      state: 'completed',
      summary: null,
    }).catch(() => {});

    ws.sessionId = null;
  }

  // Set agent back to idle
  await db.update(agents)
    .set({ state: 'idle', updatedAt: new Date() })
    .where(eq(agents.id, ws.agentId));

  redisPub.publish(`agent:${ws.agentId}`, JSON.stringify({
    type: 'agent.state',
    data: { agentId: ws.agentId, state: 'idle' },
  }));

  if (task.conversationId) {
    publishToChannel(`conv:${task.conversationId}`, {
      type: 'agent.task_complete',
      data: {
        taskId: data.taskId,
        agentId: ws.agentId,
        tokensUsed: data.tokensUsed || 0,
        costUsd: data.costUsd || 0,
      },
    });

    if (data.tokensUsed || data.costUsd) {
      publishToChannel(`conv:${task.conversationId}`, {
        type: 'agent.cost',
        data: {
          sessionId: completedSessionId,
          tokens: data.tokensUsed || 0,
          usd: data.costUsd || 0,
        },
      });
    }
  }
}

// ── Tool Events ─────────────────────────────────

async function handleToolEvent(
  ws: AgentSocket,
  eventType: 'agent.tool_start' | 'agent.tool_end',
  data: { conversationId: string; tool: string; input?: unknown; output?: unknown; status?: string }
): Promise<void> {
  publishToChannel(`conv:${data.conversationId}`, {
    type: eventType,
    data: {
      taskId: ws.sessionId,
      step: {
        tool: data.tool,
        input: data.input,
        output: data.output,
        status: eventType === 'agent.tool_start' ? 'running' : (data.status || 'completed'),
      },
    },
  });

  // Update live activity with tool info
  if (ws.sessionId) {
    if (eventType === 'agent.tool_start') {
      liveActivityService.update(`la_${ws.sessionId}`, {
        label: `Running ${data.tool}...`,
        toolName: data.tool,
        detail: typeof data.input === 'string' ? data.input.slice(0, 120) : null,
      }).catch(() => {});
    } else {
      liveActivityService.update(`la_${ws.sessionId}`, {
        label: 'Working...',
        toolName: null,
        detail: null,
      }).catch(() => {});
    }
  }
}

// ── State Updates ───────────────────────────────

async function handleStateUpdate(
  ws: AgentSocket,
  state: 'idle' | 'working' | 'paused' | 'error'
): Promise<void> {
  await db.update(agents)
    .set({ state, updatedAt: new Date() })
    .where(eq(agents.id, ws.agentId));

  redisPub.publish(`agent:${ws.agentId}`, JSON.stringify({
    type: 'agent.state',
    data: { agentId: ws.agentId, state },
  }));

  // If agent starts working, create a session
  if (state === 'working' && !ws.sessionId) {
    // Find the agent's primary conversation
    const [membership] = await db.select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, ws.botUserId))
      .limit(1);

    if (membership) {
      const [session] = await db.insert(agentSessions).values({
        agentId: ws.agentId,
        conversationId: membership.conversationId,
        state: 'active',
      }).returning();

      ws.sessionId = session.id;

      // Fetch agent info for live activity
      const [agent] = await db.select({ name: agents.name, icon: agents.icon, ownerId: agents.ownerId })
        .from(agents)
        .where(eq(agents.id, ws.agentId))
        .limit(1);

      if (agent) {
        liveActivityService.start({
          agentId: ws.agentId,
          agentName: agent.name,
          agentIcon: agent.icon ?? null,
          conversationId: membership.conversationId,
          sessionId: session.id,
          ownerId: agent.ownerId ?? '',
          label: 'Working...',
        }).catch(err => logger.warn({ err }, 'Failed to start live activity'));
      }
    }
  }
}
