import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  bigint,
  integer,
  decimal,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ═══════════════════════════════════════════════════
// USERS — human accounts + bot accounts in one table
// ═══════════════════════════════════════════════════
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 64 }).unique().notNull(),
  displayName: varchar('display_name', { length: 128 }),
  email: varchar('email', { length: 256 }).unique(),
  phone: varchar('phone', { length: 20 }).unique(),
  passwordHash: varchar('password_hash', { length: 256 }),
  avatarUrl: text('avatar_url'),
  isBot: boolean('is_bot').default(false).notNull(),
  botToken: varchar('bot_token', { length: 256 }).unique(),
  botOwnerId: uuid('bot_owner_id'),
  status: varchar('status', { length: 16 }).default('offline').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  settings: jsonb('settings').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_users_username').on(table.username),
]);

// ═══════════════════════════════════════════════════
// AGENTS — AI agent configurations (OpenClaw compatible)
// ═══════════════════════════════════════════════════
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  botUserId: uuid('bot_user_id').unique().references(() => users.id),
  ownerId: uuid('owner_id').references(() => users.id),
  slug: varchar('slug', { length: 64 }).unique().notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  icon: varchar('icon', { length: 8 }),
  model: varchar('model', { length: 256 }).notNull(),
  fallbackModels: text('fallback_models').array().default([]),
  scopes: text('scopes').array().default(['read']),
  skills: text('skills').array().default([]),
  sandbox: varchar('sandbox', { length: 32 }).default('all'),
  heartbeat: varchar('heartbeat', { length: 16 }),
  workspace: text('workspace'),
  systemPrompt: text('system_prompt'),
  config: jsonb('config').default({}).$type<Record<string, unknown>>(),
  state: varchar('state', { length: 16 }).default('idle').notNull(),
  isPrimary: boolean('is_primary').default(false).notNull(),
  parentId: uuid('parent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_agents_slug').on(table.slug),
  index('idx_agents_owner').on(table.ownerId),
]);

// ═══════════════════════════════════════════════════
// CONVERSATIONS — DMs, groups, channels
// ═══════════════════════════════════════════════════
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: varchar('type', { length: 16 }).notNull(), // dm, group, channel, agent
  name: varchar('name', { length: 256 }),
  description: text('description'),
  avatarUrl: text('avatar_url'),
  creatorId: uuid('creator_id').references(() => users.id),
  isPublic: boolean('is_public').default(false).notNull(),
  settings: jsonb('settings').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_conversations_type').on(table.type),
]);

// ═══════════════════════════════════════════════════
// CONVERSATION_MEMBERS — who's in which conversation
// ═══════════════════════════════════════════════════
export const conversationMembers = pgTable('conversation_members', {
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role: varchar('role', { length: 16 }).default('member').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }),
  mutedUntil: timestamp('muted_until', { withTimezone: true }),
  pinned: boolean('pinned').default(false).notNull(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.userId] }),
  index('idx_cm_user').on(table.userId),
]);

// ═══════════════════════════════════════════════════
// MESSAGES — the core message table
// ═══════════════════════════════════════════════════
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  senderId: uuid('sender_id').references(() => users.id).notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  type: varchar('type', { length: 16 }).default('text').notNull(),
  content: text('content'),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  replyToId: uuid('reply_to_id'),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_messages_conv_seq').on(table.conversationId, table.seq),
  index('idx_messages_sender').on(table.senderId),
  index('idx_messages_created').on(table.createdAt),
]);

// ═══════════════════════════════════════════════════
// MESSAGE_STATUS — delivery + read receipts per recipient
// ═══════════════════════════════════════════════════
export const messageStatus = pgTable('message_status', {
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  status: varchar('status', { length: 16 }).default('sent').notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.userId] }),
]);

// ═══════════════════════════════════════════════════
// ATTACHMENTS — files, photos, voice memos
// ═══════════════════════════════════════════════════
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 16 }).notNull(),
  filename: varchar('filename', { length: 512 }),
  mimeType: varchar('mime_type', { length: 128 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  storageKey: text('storage_key').notNull(),
  thumbnailKey: text('thumbnail_key'),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_attachments_msg').on(table.messageId),
]);

// ═══════════════════════════════════════════════════
// AGENT_SESSIONS — active agent execution sessions
// ═══════════════════════════════════════════════════
export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').references(() => agents.id),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  gatewaySession: text('gateway_session'),
  state: varchar('state', { length: 16 }).default('active').notNull(),
  tokensUsed: integer('tokens_used').default(0).notNull(),
  costUsd: decimal('cost_usd', { precision: 10, scale: 4 }).default('0'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
}, (table) => [
  index('idx_as_agent').on(table.agentId),
  index('idx_as_conv').on(table.conversationId),
]);

// ═══════════════════════════════════════════════════
// AGENT_TASKS — task queue for agent orchestration
// ═══════════════════════════════════════════════════
export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').references(() => agents.id),
  parentTaskId: uuid('parent_task_id'),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  messageId: uuid('message_id').references(() => messages.id),
  type: varchar('type', { length: 32 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 16 }).default('pending').notNull(),
  input: jsonb('input').default({}).$type<Record<string, unknown>>(),
  output: jsonb('output').default({}).$type<Record<string, unknown>>(),
  cost: jsonb('cost').default({}).$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_at_agent').on(table.agentId, table.status),
  index('idx_at_conv').on(table.conversationId),
]);

// ═══════════════════════════════════════════════════
// WEBHOOKS — for external integrations
// ═══════════════════════════════════════════════════
export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  botUserId: uuid('bot_user_id').references(() => users.id),
  url: text('url').notNull(),
  secret: varchar('secret', { length: 256 }),
  events: text('events').array().default(['message.new']),
  active: boolean('active').default(true).notNull(),
  failureCount: integer('failure_count').default(0).notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════
// CRON_JOBS — scheduled agent tasks
// ═══════════════════════════════════════════════════
export const cronJobs = pgTable('cron_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').references(() => agents.id),
  name: varchar('name', { length: 128 }).notNull(),
  schedule: varchar('schedule', { length: 64 }).notNull(),
  taskType: varchar('task_type', { length: 32 }).notNull(),
  taskConfig: jsonb('task_config').default({}).$type<Record<string, unknown>>(),
  target: varchar('target', { length: 256 }),
  active: boolean('active').default(true).notNull(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
