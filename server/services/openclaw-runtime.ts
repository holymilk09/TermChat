// ═══════════════════════════════════════════════════
// OpenClaw Runtime Adapter
//
// Wraps the existing OpenClawBridge as an AgentRuntime
// so the runtime manager can route operations to it.
// ═══════════════════════════════════════════════════

import type { AgentRuntime, RuntimeCapabilities, NormalizedEventHandler } from './agent-runtime.js';
import type { OpenClawBridge } from './openclaw.js';

export class OpenClawRuntimeAdapter implements AgentRuntime {
  readonly type = 'openclaw' as const;
  readonly capabilities: RuntimeCapabilities = {
    dispatch: true,
    approvals: true,
    commands: false,
    contextDiagnostics: true,
    typing: false,
  };

  private eventHandlers: NormalizedEventHandler[] = [];

  constructor(private bridge: OpenClawBridge) {}

  async sendMessage(agentId: string, message: string, conversationId: string): Promise<boolean> {
    await this.bridge.sendToAgent(agentId, message, conversationId);
    return true;
  }

  async sendApprovalResponse(
    agentId: string,
    taskId: string,
    approved: boolean,
    conversationId: string,
    reason?: string,
    edits?: { path: string; content: string }[],
  ): Promise<boolean> {
    await this.bridge.sendApprovalResponse(taskId, approved, conversationId, reason, edits);
    return true;
  }

  async sendCommand(_agentId: string, _command: string, _args?: unknown): Promise<boolean> {
    // OpenClaw doesn't support direct commands
    return false;
  }

  async dispatch(
    parentAgentId: string,
    targetSlug: string,
    task: string,
    conversationId: string,
  ): Promise<string | null> {
    return this.bridge.dispatch(parentAgentId, targetSlug, task, conversationId);
  }

  isAgentReachable(agentId: string): boolean {
    return this.bridge.hasSession(agentId);
  }

  async initialize(): Promise<void> {
    // Wire up normalized event forwarding
    this.bridge.onNormalizedEvent = (event) => {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    };
    await this.bridge.connect();
  }

  async shutdown(): Promise<void> {
    await this.bridge.disconnect();
  }

  onEvent(handler: NormalizedEventHandler): void {
    this.eventHandlers.push(handler);
  }
}
