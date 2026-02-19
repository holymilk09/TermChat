// ═══════════════════════════════════════════════════
// Direct Gateway Runtime Adapter
//
// Wraps the existing agent-gateway.ts WebSocket server
// as an AgentRuntime so the runtime manager can route
// operations to directly-connected agents.
// ═══════════════════════════════════════════════════

import type { AgentRuntime, RuntimeCapabilities, NormalizedEventHandler } from './agent-runtime.js';
import { sendToAgent, isAgentOnline } from '../ws/agent-gateway.js';

export class DirectGatewayRuntimeAdapter implements AgentRuntime {
  readonly type = 'direct' as const;
  readonly capabilities: RuntimeCapabilities = {
    dispatch: false,
    approvals: true,
    commands: true,
    contextDiagnostics: false,
    typing: true,
  };

  private eventHandlers: NormalizedEventHandler[] = [];

  async sendMessage(agentId: string, message: string, conversationId: string): Promise<boolean> {
    return sendToAgent(agentId, {
      type: 'message.new',
      data: { content: message, conversationId },
    });
  }

  async sendApprovalResponse(
    agentId: string,
    taskId: string,
    approved: boolean,
    _conversationId: string,
    reason?: string,
    edits?: { path: string; content: string }[],
  ): Promise<boolean> {
    return sendToAgent(agentId, {
      type: 'approval.respond',
      data: { taskId, approved, reason, edits },
    });
  }

  async sendCommand(agentId: string, command: string, args?: unknown): Promise<boolean> {
    return sendToAgent(agentId, {
      type: 'agent.command',
      data: { command, args },
    });
  }

  isAgentReachable(agentId: string): boolean {
    return isAgentOnline(agentId);
  }

  async initialize(): Promise<void> {
    // The agent gateway WebSocket server is already set up by setupAgentGateway().
    // No additional initialization needed.
  }

  async shutdown(): Promise<void> {
    // Agent gateway lifecycle is managed by the HTTP server.
    // No additional shutdown needed.
  }

  onEvent(handler: NormalizedEventHandler): void {
    this.eventHandlers.push(handler);
  }
}
