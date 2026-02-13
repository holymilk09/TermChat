import { redis, redisPub } from './redis.js';
import { logger } from './logger.js';
import type { LiveActivity, LiveActivityState } from '../../shared/types.js';

/**
 * Live Activity Service
 *
 * Manages real-time activity state for agents running on remote devices
 * (VPS, Mac Mini, etc). Mobile clients consume these events to render:
 *   - iOS: Dynamic Island (compact/expanded) + Lock Screen Live Activity
 *   - Android: Ongoing notification with live content
 *
 * Activities are stored in Redis for fast access and auto-expire after
 * the session ends. Each user can have multiple concurrent activities
 * (one per active agent session).
 */

const ACTIVITY_KEY_PREFIX = 'live_activity:';
const USER_ACTIVITIES_PREFIX = 'user_activities:';
const ACTIVITY_TTL = 60 * 60 * 4; // 4 hours max

export class LiveActivityService {

  /**
   * Start a new live activity when an agent begins working.
   * Broadcasts activity.start to all clients watching the conversation
   * and to the agent owner's private channel.
   */
  async start(params: {
    agentId: string;
    agentName: string;
    agentIcon: string | null;
    conversationId: string;
    sessionId: string;
    ownerId: string;
    label: string;
  }): Promise<LiveActivity> {
    const id = `la_${params.sessionId}`;
    const now = new Date().toISOString();

    const activity: LiveActivity = {
      id,
      agentId: params.agentId,
      agentName: params.agentName,
      agentIcon: params.agentIcon,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      state: 'running',
      label: params.label,
      detail: null,
      toolName: null,
      startedAt: now,
      updatedAt: now,
      metadata: {},
    };

    // Store in Redis
    await redis.setex(
      `${ACTIVITY_KEY_PREFIX}${id}`,
      ACTIVITY_TTL,
      JSON.stringify(activity),
    );

    // Track per-user (for listing active activities on reconnect)
    await redis.sadd(`${USER_ACTIVITIES_PREFIX}${params.ownerId}`, id);
    await redis.expire(`${USER_ACTIVITIES_PREFIX}${params.ownerId}`, ACTIVITY_TTL);

    // Broadcast to conversation + owner's private channel
    const event = JSON.stringify({ type: 'activity.start', data: activity });
    redisPub.publish(`conv:${params.conversationId}`, event);
    redisPub.publish(`user:${params.ownerId}`, event);

    logger.info({ activityId: id, agentId: params.agentId, label: params.label }, 'Live activity started');

    return activity;
  }

  /**
   * Update a live activity — called when the agent changes what it's doing.
   * Only sends the changed fields to minimize bandwidth.
   */
  async update(activityId: string, patch: {
    label?: string;
    detail?: string | null;
    toolName?: string | null;
    state?: LiveActivityState;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const raw = await redis.get(`${ACTIVITY_KEY_PREFIX}${activityId}`);
    if (!raw) return;

    const activity: LiveActivity = JSON.parse(raw);
    const now = new Date().toISOString();

    if (patch.label !== undefined) activity.label = patch.label;
    if (patch.detail !== undefined) activity.detail = patch.detail;
    if (patch.toolName !== undefined) activity.toolName = patch.toolName;
    if (patch.state !== undefined) activity.state = patch.state;
    if (patch.metadata) Object.assign(activity.metadata, patch.metadata);
    activity.updatedAt = now;

    await redis.setex(
      `${ACTIVITY_KEY_PREFIX}${activityId}`,
      ACTIVITY_TTL,
      JSON.stringify(activity),
    );

    const eventData: Record<string, unknown> = { id: activityId, updatedAt: now };
    if (patch.label !== undefined) eventData.label = patch.label;
    if (patch.detail !== undefined) eventData.detail = patch.detail;
    if (patch.toolName !== undefined) eventData.toolName = patch.toolName;
    if (patch.state !== undefined) eventData.state = patch.state;

    const event = JSON.stringify({ type: 'activity.update', data: eventData });
    redisPub.publish(`conv:${activity.conversationId}`, event);
  }

  /**
   * End a live activity — agent finished, failed, or was cancelled.
   */
  async end(activityId: string, result: {
    state: 'completed' | 'failed';
    summary: string | null;
    ownerId?: string;
  }): Promise<void> {
    const raw = await redis.get(`${ACTIVITY_KEY_PREFIX}${activityId}`);
    if (!raw) return;

    const activity: LiveActivity = JSON.parse(raw);

    const event = JSON.stringify({
      type: 'activity.end',
      data: { id: activityId, state: result.state, summary: result.summary },
    });

    redisPub.publish(`conv:${activity.conversationId}`, event);

    // Clean up Redis
    await redis.del(`${ACTIVITY_KEY_PREFIX}${activityId}`);
    if (result.ownerId) {
      await redis.srem(`${USER_ACTIVITIES_PREFIX}${result.ownerId}`, activityId);
    }

    logger.info({ activityId, state: result.state }, 'Live activity ended');
  }

  /**
   * Get all active live activities for a user.
   * Called when a mobile client reconnects to restore Dynamic Island / notification state.
   */
  async getForUser(userId: string): Promise<LiveActivity[]> {
    const ids = await redis.smembers(`${USER_ACTIVITIES_PREFIX}${userId}`);
    if (ids.length === 0) return [];

    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.get(`${ACTIVITY_KEY_PREFIX}${id}`);
    }

    const results = await pipeline.exec();
    if (!results) return [];

    const activities: LiveActivity[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const [err, raw] = results[i];
      if (!err && raw) {
        activities.push(JSON.parse(raw as string));
      } else {
        staleIds.push(ids[i]);
      }
    }

    // Clean stale references
    if (staleIds.length > 0) {
      await redis.srem(`${USER_ACTIVITIES_PREFIX}${userId}`, ...staleIds);
    }

    return activities;
  }

  /**
   * Get a single live activity by ID.
   */
  async get(activityId: string): Promise<LiveActivity | null> {
    const raw = await redis.get(`${ACTIVITY_KEY_PREFIX}${activityId}`);
    return raw ? JSON.parse(raw) : null;
  }
}

export const liveActivityService = new LiveActivityService();
