// ═══════════════════════════════════════════════════
// Shared TypeScript types for TermChat
// Used by both server and client
// ═══════════════════════════════════════════════════

// ── User Types ──────────────────────────────────

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  status: UserStatus;
  lastSeenAt: string | null;
  createdAt: string;
}

export type UserStatus = 'online' | 'offline' | 'away' | 'dnd';

// ── Conversation Types ──────────────────────────

export interface Conversation {
  id: string;
  type: ConversationType;
  name: string | null;
  description: string | null;
  avatarUrl: string | null;
  creatorId: string | null;
  isPublic: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ConversationType = 'dm' | 'group' | 'channel' | 'agent';

export interface ConversationMember {
  conversationId: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
  lastReadAt: string | null;
  mutedUntil: string | null;
  pinned: boolean;
}

export type MemberRole = 'owner' | 'admin' | 'member' | 'bot';

// ── Message Types ───────────────────────────────

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  seq: number;
  type: MessageType;
  content: string | null;
  metadata: Record<string, unknown>;
  replyToId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  // Populated fields
  sender?: User;
}

export type MessageType = 'text' | 'system' | 'tool' | 'dispatch' | 'code' | 'approval';

export interface MessageStatusRecord {
  messageId: string;
  userId: string;
  status: DeliveryStatus;
  deliveredAt: string | null;
  readAt: string | null;
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read';

// ── Attachment Types ────────────────────────────

export interface Attachment {
  id: string;
  messageId: string;
  type: AttachmentType;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  storageKey: string;
  thumbnailKey: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: string;
}

export type AttachmentType = 'photo' | 'file' | 'voice' | 'video';

// ── Agent Types ─────────────────────────────────

export interface Agent {
  id: string;
  botUserId: string | null;
  ownerId: string | null;
  slug: string;
  name: string;
  icon: string | null;
  model: string;
  fallbackModels: string[];
  scopes: string[];
  skills: string[];
  sandbox: string;
  heartbeat: string | null;
  config: AgentConfig;
  state: AgentState;
  isPrimary: boolean;
  parentId: string | null;
  createdAt: string;
}

export type AgentState = 'idle' | 'working' | 'paused' | 'error';

// ── Agent Config (OpenClaw v2026.2.13+) ─────────
// Typed config fields that map to OpenClaw gateway settings.
// Stored in agents.config JSONB column.

export interface AgentConfig {
  $schema?: string;
  gateway?: {
    tools?: {
      allow?: string[];   // tool names explicitly allowed (e.g. ['sessions_spawn'])
      deny?: string[];    // tool names explicitly denied
    };
  };
  session?: {
    dmScope?: 'user' | 'conversation';   // multi-user DM isolation mode
    replyToMode?: 'auto' | 'explicit' | 'off';  // implicit reply threading
  };
  historyLimit?: number;   // max messages sent as context to the agent
  [key: string]: unknown;  // preserve arbitrary keys like $schema
}

// ── WebSocket Event Types ───────────────────────

// Server → Client
export type ServerEvent =
  | { type: 'message.new'; data: Message }
  | { type: 'message.edit'; data: { id: string; content: string; editedAt: string } }
  | { type: 'message.delete'; data: { id: string } }
  | { type: 'typing.start'; data: { conversationId: string; userId: string; username: string } }
  | { type: 'typing.stop'; data: { conversationId: string; userId: string } }
  | { type: 'presence.update'; data: { userId: string; status: UserStatus; lastSeenAt: string } }
  | { type: 'status.delivered'; data: { messageId: string } }
  | { type: 'status.read'; data: { messageId: string } }
  | { type: 'conversation.created'; data: Conversation }
  | { type: 'conversation.updated'; data: Partial<Conversation> & { id: string } }
  | { type: 'member.joined'; data: { conversationId: string; userId: string; role: MemberRole } }
  | { type: 'member.left'; data: { conversationId: string; userId: string } }
  // Agent-specific events
  | { type: 'agent.state'; data: { agentId: string; state: AgentState } }
  | { type: 'agent.tool_start'; data: { taskId: string; step: ToolStep } }
  | { type: 'agent.tool_end'; data: { taskId: string; step: ToolStep } }
  | { type: 'agent.dispatch'; data: { taskId: string; agents: DispatchAgent[] } }
  | { type: 'agent.cost'; data: { sessionId: string; tokens: number; usd: number } }
  | { type: 'agent.approval'; data: { taskId: string; action: string; detail: string; diff?: { path: string; before: string | null; after: string; language?: string }[] } }
  | { type: 'agent.context_diagnostics'; data: { sessionId: string; messageCount: number; tokenCount: number; provider: string; model: string } }
  | { type: 'agent.approval_resolved'; data: { taskId: string; decision: 'approved' | 'denied' | 'adjusted'; respondedBy: string; reason: string | null; hasEdits: boolean } }
  // Live Activity events (iOS Dynamic Island / Android ongoing notification)
  | { type: 'activity.start'; data: LiveActivity }
  | { type: 'activity.update'; data: Partial<LiveActivity> & { id: string } }
  | { type: 'activity.end'; data: { id: string; state: 'completed' | 'failed'; summary: string | null } };

// Client → Server
export type ClientEvent =
  | { type: 'message.send'; data: { conversationId: string; content: string; replyTo?: string } }
  | { type: 'typing.start'; data: { conversationId: string } }
  | { type: 'typing.stop'; data: { conversationId: string } }
  | { type: 'message.read'; data: { conversationId: string; upToSeq: number } }
  | { type: 'approval.respond'; data: { taskId: string; approved: boolean; reason?: string; edits?: { path: string; content: string }[] } }
  | { type: 'agent.command'; data: { command: string; args?: unknown } };

export interface ToolStep {
  tool: string;
  input: unknown;
  output?: unknown;
  status: 'running' | 'completed' | 'failed';
}

export interface DispatchAgent {
  slug: string;
  name: string;
  task: string;
  status: string;
}

// ── Live Activity Types ─────────────────────────
// Used by iOS (Dynamic Island / Lock Screen) and Android (Ongoing Notification)
// to show real-time bot task progress when the app is backgrounded.

export interface LiveActivity {
  id: string;                       // unique activity ID
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  conversationId: string;
  sessionId: string;
  state: LiveActivityState;
  label: string;                    // human-readable action: "Analyzing code..."
  detail: string | null;            // optional extra context: "file: main.ts"
  toolName: string | null;          // current tool if any
  startedAt: string;                // ISO timestamp of when activity began
  updatedAt: string;                // ISO timestamp of last update
  metadata: Record<string, unknown>;
}

export type LiveActivityState = 'running' | 'waiting' | 'paused' | 'completed' | 'failed';

// Server → Client live activity events
export type LiveActivityEvent =
  | { type: 'activity.start'; data: LiveActivity }
  | { type: 'activity.update'; data: Partial<LiveActivity> & { id: string } }
  | { type: 'activity.end'; data: { id: string; state: 'completed' | 'failed'; summary: string | null } };

// ── Pairing & Device Auth Types ─────────────────

export interface PairingCode {
  code: string;
  agentId: string | null;
  status: PairingStatus;
  expiresAt: string;
  exchangedAt: string | null;
  createdAt: string;
}

export type PairingStatus = 'pending' | 'exchanged' | 'expired';

export interface AgentToken {
  id: string;
  agentId: string;
  name: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface DeviceAuthRequest {
  userCode: string;
  deviceCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export type DeviceAuthStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairingExchangeResult {
  token: string;
  agent: {
    id: string;
    slug: string;
    name: string;
    model: string;
    scopes: string[];
    systemPrompt: string | null;
  };
  owner: {
    username: string;
    displayName: string | null;
  };
  gateway: {
    url: string;
    protocol: string;
  };
}

// ── Agent Gateway Event Types ───────────────────
// Events sent FROM agents TO the server via /ws/agent

export type AgentClientEvent =
  | { type: 'message.send'; data: { conversationId: string; content: string; type?: string; metadata?: Record<string, unknown> } }
  | { type: 'typing.start'; data: { conversationId: string } }
  | { type: 'typing.stop'; data: { conversationId: string } }
  | { type: 'task.update'; data: { taskId: string; status: string; output?: unknown } }
  | { type: 'task.complete'; data: { taskId: string; output?: unknown; tokensUsed?: number; costUsd?: number } }
  | { type: 'tool.start'; data: { conversationId: string; tool: string; input?: unknown } }
  | { type: 'tool.end'; data: { conversationId: string; tool: string; output?: unknown; status: string } }
  | { type: 'state.update'; data: { state: AgentState } };

// Events sent FROM the server TO agents via /ws/agent
export type AgentServerEvent =
  | { type: 'connected'; data: { agentId: string; slug: string; name: string; conversations: string[]; protocol: string } }
  | { type: 'message.new'; data: Message }
  | { type: 'message.ack'; data: { messageId: string; seq: number } }
  | { type: 'approval.respond'; data: { taskId: string; approved: boolean; reason?: string; edits?: { path: string; content: string }[] } }
  | { type: 'agent.command'; data: { command: string; args?: unknown } }
  | { type: 'error'; data: { message: string } };

// ── API Types ───────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  hasMore: boolean;
  cursor?: string;
}

// ── Conversation with extra info ────────────────

export interface ConversationWithDetails extends Conversation {
  members: (ConversationMember & { user: User })[];
  lastMessage: Message | null;
  unreadCount: number;
}
