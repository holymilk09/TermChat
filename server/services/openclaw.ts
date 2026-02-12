import WebSocket from 'ws';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agents, agentSessions, agentTasks, messages, users, conversations } from '../db/schema.js';
import { redis, redisPub } from './redis.js';
import { logger } from './logger.js';
import { config } from '../config.js';
import { sql } from 'drizzle-orm';

interface AgentSessionState {
  agentId: string;
  conversationId: string;
  sessionDbId: string;
  gatewaySessionId?: string;
}

export class OpenClawBridge {
  private ws: WebSocket | null = null;
  private sessions = new Map<string, AgentSessionState>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 2000;
  private connected = false;

  async connect(gatewayUrl?: string): Promise<void> {
    const url = gatewayUrl || config.openclawGateway;
    logger.info({ url }, 'Connecting to OpenClaw Gateway');

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.info('Connected to OpenClaw Gateway');
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleGatewayEvent(event);
        } catch (err) {
          logger.error({ err }, 'Failed to parse Gateway event');
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        logger.warn('Disconnected from OpenClaw Gateway');
        this.attemptReconnect(url);
      });

      this.ws.on('error', (err) => {
        logger.error({ err }, 'OpenClaw Gateway connection error');
      });
    } catch (err) {
      logger.error({ err }, 'Failed to connect to OpenClaw Gateway');
      this.attemptReconnect(url);
    }
  }

  private attemptReconnect(url: string): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached for OpenClaw Gateway');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    logger.info({ delay, attempt: this.reconnectAttempts }, 'Reconnecting to OpenClaw Gateway');
    setTimeout(() => this.connect(url), delay);
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  // Send user message to agent
  async sendToAgent(agentId: string, message: string, conversationId: string): Promise<void> {
    if (!this.isConnected()) {
      logger.warn('Cannot send to agent: Gateway not connected');
      return;
    }

    const [agent] = await db.select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      logger.error({ agentId }, 'Agent not found');
      return;
    }

    const session = await this.getOrCreateSession(agentId, conversationId);

    this.ws!.send(JSON.stringify({
      type: 'message',
      session: session.gatewaySessionId,
      agent_id: agentId,
      content: message,
      model: agent.model,
      conversation_id: conversationId,
    }));

    // Update agent state to working
    await db.update(agents)
      .set({ state: 'working', updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    redisPub.publish(`agent:${agentId}`, JSON.stringify({
      type: 'agent.state',
      data: { agentId, state: 'working' },
    }));
  }

  // Dispatch sub-agent task (Brain → Coder)
  async dispatch(parentAgentId: string, targetSlug: string, task: string, conversationId: string): Promise<string | null> {
    if (!this.isConnected()) {
      logger.warn('Cannot dispatch: Gateway not connected');
      return null;
    }

    const parentSession = this.sessions.get(parentAgentId);
    if (!parentSession) {
      logger.error({ parentAgentId }, 'No active session for parent agent');
      return null;
    }

    // Find target agent
    const [targetAgent] = await db.select()
      .from(agents)
      .where(eq(agents.slug, targetSlug))
      .limit(1);

    if (!targetAgent) {
      logger.error({ targetSlug }, 'Target agent not found');
      return null;
    }

    // Create task record
    const [taskRecord] = await db.insert(agentTasks).values({
      agentId: targetAgent.id,
      conversationId,
      type: 'dispatch',
      description: task,
      status: 'pending',
      input: { parentAgentId, task },
    }).returning();

    this.ws!.send(JSON.stringify({
      type: 'sessions_spawn',
      parent_session: parentSession.gatewaySessionId,
      agent: targetSlug,
      task,
      task_id: taskRecord.id,
    }));

    // Broadcast dispatch event
    redisPub.publish(`conv:${conversationId}`, JSON.stringify({
      type: 'agent.dispatch',
      data: {
        taskId: taskRecord.id,
        agents: [{
          slug: targetSlug,
          name: targetAgent.name,
          task,
          status: 'pending',
        }],
      },
    }));

    return taskRecord.id;
  }

  private async getOrCreateSession(agentId: string, conversationId: string): Promise<AgentSessionState> {
    const existing = this.sessions.get(agentId);
    if (existing && existing.conversationId === conversationId) {
      return existing;
    }

    // Create new session in DB
    const [session] = await db.insert(agentSessions).values({
      agentId,
      conversationId,
      state: 'active',
    }).returning();

    const state: AgentSessionState = {
      agentId,
      conversationId,
      sessionDbId: session.id,
      gatewaySessionId: session.id, // Use DB ID as gateway session ID
    };

    this.sessions.set(agentId, state);
    return state;
  }

  private async handleGatewayEvent(event: any): Promise<void> {
    switch (event.type) {
      case 'tool_start':
      case 'tool_end': {
        const session = this.findSessionByGateway(event.session);
        if (!session) return;

        redisPub.publish(`conv:${session.conversationId}`, JSON.stringify({
          type: `agent.${event.type}`,
          data: {
            taskId: event.task_id,
            step: {
              tool: event.tool,
              input: event.input,
              output: event.output,
              status: event.type === 'tool_start' ? 'running' : 'completed',
            },
          },
        }));
        break;
      }

      case 'message': {
        const session = this.findSessionByGateway(event.session);
        if (!session) return;

        await this.storeAndBroadcast(session, event.content);
        break;
      }

      case 'approval_request': {
        const session = this.findSessionByGateway(event.session);
        if (!session) return;

        redisPub.publish(`conv:${session.conversationId}`, JSON.stringify({
          type: 'agent.approval',
          data: {
            taskId: event.task_id,
            action: event.action,
            detail: event.detail,
          },
        }));
        break;
      }

      case 'session_complete': {
        const session = this.findSessionByGateway(event.session);
        if (!session) return;

        // Update session in DB
        await db.update(agentSessions)
          .set({
            state: 'completed',
            endedAt: new Date(),
            tokensUsed: event.tokens_used || 0,
            costUsd: String(event.cost_usd || 0),
          })
          .where(eq(agentSessions.id, session.sessionDbId));

        // Set agent back to idle
        await db.update(agents)
          .set({ state: 'idle', updatedAt: new Date() })
          .where(eq(agents.id, session.agentId));

        redisPub.publish(`agent:${session.agentId}`, JSON.stringify({
          type: 'agent.state',
          data: { agentId: session.agentId, state: 'idle' },
        }));

        // Broadcast cost update
        if (event.tokens_used || event.cost_usd) {
          redisPub.publish(`conv:${session.conversationId}`, JSON.stringify({
            type: 'agent.cost',
            data: {
              sessionId: session.sessionDbId,
              tokens: event.tokens_used || 0,
              usd: event.cost_usd || 0,
            },
          }));
        }

        this.sessions.delete(session.agentId);
        break;
      }

      case 'error': {
        const session = this.findSessionByGateway(event.session);
        if (!session) return;

        logger.error({ event }, 'Agent error from Gateway');

        await db.update(agentSessions)
          .set({ state: 'failed', endedAt: new Date() })
          .where(eq(agentSessions.id, session.sessionDbId));

        await db.update(agents)
          .set({ state: 'error', updatedAt: new Date() })
          .where(eq(agents.id, session.agentId));

        redisPub.publish(`agent:${session.agentId}`, JSON.stringify({
          type: 'agent.state',
          data: { agentId: session.agentId, state: 'error' },
        }));

        this.sessions.delete(session.agentId);
        break;
      }
    }
  }

  private findSessionByGateway(gatewaySessionId: string): AgentSessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.gatewaySessionId === gatewaySessionId) {
        return session;
      }
    }
    return undefined;
  }

  private async storeAndBroadcast(session: AgentSessionState, content: string): Promise<void> {
    // Get next sequence
    const [seqResult] = await db.select({
      maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0) + 1`,
    })
      .from(messages)
      .where(eq(messages.conversationId, session.conversationId));

    // Get agent's bot user ID
    const [agent] = await db.select({ botUserId: agents.botUserId })
      .from(agents)
      .where(eq(agents.id, session.agentId))
      .limit(1);

    if (!agent?.botUserId) return;

    const [msg] = await db.insert(messages).values({
      conversationId: session.conversationId,
      senderId: agent.botUserId,
      seq: seqResult.maxSeq,
      type: 'text',
      content,
    }).returning();

    const [sender] = await db.select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isBot: users.isBot,
    })
      .from(users)
      .where(eq(users.id, agent.botUserId))
      .limit(1);

    redisPub.publish(`conv:${session.conversationId}`, JSON.stringify({
      type: 'message.new',
      data: { ...msg, sender },
    }));
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.sessions.clear();
  }
}

// Singleton
export const openclawBridge = new OpenClawBridge();
