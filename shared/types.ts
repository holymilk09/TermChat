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
  state: AgentState;
  isPrimary: boolean;
  parentId: string | null;
  createdAt: string;
}

export type AgentState = 'idle' | 'working' | 'paused' | 'error';

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
  | { type: 'agent.approval'; data: { taskId: string; action: string; detail: string } }
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
  | { type: 'approval.respond'; data: { taskId: string; approved: boolean } }
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
