import type { WebSocket } from 'ws';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, messages, messageStatus, agentTasks, agents as agentsTable } from '../db/schema.js';
import { redis } from '../services/redis.js';
import { logger } from '../services/logger.js';
import { subscribeToChannel, publishToChannel } from './rooms.js';
import { runtimeManager } from '../services/agent-runtime-manager.js';
import { createMessage } from '../services/message.js';
import type { ClientEvent } from '../../shared/types.js';

export async function handleClientEvent(ws: WebSocket, userId: string, username: string, event: ClientEvent) {
  switch (event.type) {
    case 'message.send':
      await handleMessageSend(ws, userId, event.data);
      break;
    case 'typing.start':
      await handleTypingStart(userId, username, event.data.conversationId);
      break;
    case 'typing.stop':
      await handleTypingStop(userId, event.data.conversationId);
      break;
    case 'message.read':
      await handleMessageRead(userId, event.data.conversationId, event.data.upToSeq);
      break;
    case 'approval.respond':
      await handleApprovalRespond(userId, event.data);
      break;
    case 'agent.command':
      await handleAgentCommand(userId, event.data);
      break;
    default:
      logger.warn({ type: (event as any).type }, 'Unknown client event type');
  }
}

async function handleMessageSend(
  ws: WebSocket,
  userId: string,
  data: { conversationId: string; content: string; replyTo?: string }
) {
  // Check membership
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, data.conversationId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Not a member of this conversation' } }));
    return;
  }

  // Clear typing indicator
  await redis.del(`typing:${data.conversationId}:${userId}`);

  await createMessage({
    conversationId: data.conversationId,
    senderId: userId,
    content: data.content,
    replyToId: data.replyTo,
  });
}

async function handleTypingStart(userId: string, username: string, conversationId: string) {
  await redis.setex(`typing:${conversationId}:${userId}`, 5, '1');
  publishToChannel(`conv:${conversationId}`, {
    type: 'typing.start',
    data: { conversationId, userId, username },
  });
}

async function handleTypingStop(userId: string, conversationId: string) {
  await redis.del(`typing:${conversationId}:${userId}`);
  publishToChannel(`conv:${conversationId}`, {
    type: 'typing.stop',
    data: { conversationId, userId },
  });
}

async function handleMessageRead(userId: string, conversationId: string, upToSeq: number) {
  // Update last_read_at
  await db.update(conversationMembers)
    .set({ lastReadAt: new Date() })
    .where(and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId)
    ));

  // Update message statuses
  const unread = await db.select({
    messageId: messageStatus.messageId,
  })
    .from(messageStatus)
    .innerJoin(messages, eq(messageStatus.messageId, messages.id))
    .where(and(
      eq(messages.conversationId, conversationId),
      eq(messageStatus.userId, userId),
      sql`${messageStatus.status} != 'read'`,
      sql`${messages.seq} <= ${upToSeq}`
    ));

  for (const s of unread) {
    await db.update(messageStatus)
      .set({ status: 'read', readAt: new Date() })
      .where(and(
        eq(messageStatus.messageId, s.messageId),
        eq(messageStatus.userId, userId)
      ));
  }
}

async function handleApprovalRespond(
  userId: string,
  data: { taskId: string; approved: boolean; reason?: string; edits?: { path: string; content: string }[] }
) {
  // Find which conversation and agent this approval belongs to
  const [task] = await db.select({
    conversationId: agentTasks.conversationId,
    agentId: agentTasks.agentId,
  })
    .from(agentTasks)
    .where(eq(agentTasks.id, data.taskId))
    .limit(1);

  if (!task?.conversationId) {
    logger.warn({ taskId: data.taskId }, 'Approval response for unknown task');
    return;
  }

  // Verify user is a member of the conversation
  const [membership] = await db.select()
    .from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, task.conversationId),
      eq(conversationMembers.userId, userId)
    ))
    .limit(1);

  if (!membership) {
    logger.warn({ userId, taskId: data.taskId }, 'Approval from non-member');
    return;
  }

  // Record the decision in the DB
  const decision = data.approved ? 'approved' : (data.edits?.length ? 'adjusted' : 'denied');
  await db.update(agentTasks)
    .set({
      status: decision,
      output: {
        decision,
        respondedBy: userId,
        reason: data.reason || null,
        edits: data.edits || null,
        respondedAt: new Date().toISOString(),
      } as Record<string, unknown>,
    })
    .where(eq(agentTasks.id, data.taskId));

  // Route approval to the correct runtime for this agent
  if (task.agentId) {
    await runtimeManager.sendApprovalResponse(
      task.agentId, data.taskId, data.approved, task.conversationId, data.reason, data.edits
    );
  }

  // Broadcast decision back to conversation so all clients can update UI
  publishToChannel(`conv:${task.conversationId}`, {
    type: 'agent.approval_resolved',
    data: {
      taskId: data.taskId,
      decision,
      respondedBy: userId,
      reason: data.reason || null,
      hasEdits: !!(data.edits?.length),
    },
  });

  logger.info({ taskId: data.taskId, decision, userId }, 'Approval response routed');
}

async function handleAgentCommand(
  userId: string,
  data: { command: string; args?: unknown }
) {
  // Route command to any connected agents owned by this user
  const userAgents = await db.select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.ownerId, userId));

  for (const agent of userAgents) {
    await runtimeManager.sendCommand(agent.id, data.command, data.args);
  }

  logger.info({ command: data.command, userId }, 'Agent command routed');
}

export async function subscribeUserToConversations(ws: WebSocket, userId: string) {
  const memberships = await db.select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, userId));

  for (const m of memberships) {
    subscribeToChannel(ws, `conv:${m.conversationId}`);
  }

  logger.debug({ userId, count: memberships.length }, 'Subscribed user to conversation channels');
}
