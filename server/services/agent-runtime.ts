// ═══════════════════════════════════════════════════
// Agent Runtime Abstraction Layer
//
// Defines the interface all agent runtimes implement,
// normalized event types, and runtime capabilities.
// ═══════════════════════════════════════════════════

export type RuntimeType = 'openclaw' | 'direct' | (string & {});

export interface RuntimeCapabilities {
  dispatch: boolean;
  approvals: boolean;
  commands: boolean;
  contextDiagnostics: boolean;
  typing: boolean;
}

// ── Normalized Agent Events ─────────────────────
// Discriminated union of all events any runtime can emit.
// Both runtimes translate their native events into these types.

export type NormalizedAgentEvent =
  | { type: 'tool_start'; agentId: string; conversationId: string; taskId?: string; tool: string; input?: unknown }
  | { type: 'tool_end'; agentId: string; conversationId: string; taskId?: string; tool: string; output?: unknown; status: string }
  | { type: 'message'; agentId: string; conversationId: string; content: string }
  | { type: 'approval_request'; agentId: string; conversationId: string; taskId: string; action: string; detail: string; diff?: { path: string; before: string | null; after: string; language?: string }[] }
  | { type: 'session_complete'; agentId: string; conversationId: string; sessionId: string; tokensUsed?: number; costUsd?: number; summary?: string }
  | { type: 'error'; agentId: string; conversationId: string; sessionId: string; error?: string }
  | { type: 'context_diagnostics'; agentId: string; conversationId: string; sessionId: string; messageCount: number; tokenCount: number; provider: string; model: string }
  | { type: 'typing'; agentId: string; conversationId: string; isTyping: boolean }
  | { type: 'state_change'; agentId: string; state: 'idle' | 'working' | 'paused' | 'error' }
  | { type: 'task_update'; agentId: string; conversationId: string; taskId: string; status: string; output?: unknown };

export type NormalizedEventHandler = (event: NormalizedAgentEvent) => void;

// ── Agent Runtime Interface ─────────────────────

export interface AgentRuntime {
  readonly type: RuntimeType;
  readonly capabilities: RuntimeCapabilities;

  /** Send a user message to an agent. */
  sendMessage(agentId: string, message: string, conversationId: string): Promise<boolean>;

  /** Forward an approval decision to an agent. */
  sendApprovalResponse(
    agentId: string,
    taskId: string,
    approved: boolean,
    conversationId: string,
    reason?: string,
    edits?: { path: string; content: string }[],
  ): Promise<boolean>;

  /** Send a command to an agent. */
  sendCommand(agentId: string, command: string, args?: unknown): Promise<boolean>;

  /** Dispatch a sub-agent task (e.g. Brain → Coder). Not all runtimes support this. */
  dispatch?(
    parentAgentId: string,
    targetSlug: string,
    task: string,
    conversationId: string,
  ): Promise<string | null>;

  /** Check if an agent is currently reachable through this runtime. */
  isAgentReachable(agentId: string): boolean;

  /** Initialize the runtime (connect, set up listeners, etc.). */
  initialize(): Promise<void>;

  /** Gracefully shut down the runtime. */
  shutdown(): Promise<void>;

  /** Subscribe to normalized events from this runtime. */
  onEvent(handler: NormalizedEventHandler): void;
}
