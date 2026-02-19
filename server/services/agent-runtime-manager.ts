// ═══════════════════════════════════════════════════
// Agent Runtime Manager — Central Router
//
// Routes agent operations to the correct runtime based
// on agentId → runtime bindings. Bindings are set when
// agents connect (direct gateway) or discovered via
// runtime probing (OpenClaw session tracking).
// ═══════════════════════════════════════════════════

import type { AgentRuntime, RuntimeType, NormalizedEventHandler } from './agent-runtime.js';
import { logger } from './logger.js';

class AgentRuntimeManager {
  private runtimes = new Map<RuntimeType, AgentRuntime>();
  private agentRuntimeBindings = new Map<string, RuntimeType>();
  private eventHandlers: NormalizedEventHandler[] = [];

  /** Register a runtime adapter. */
  registerRuntime(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.type, runtime);
    // Wire up event forwarding from this runtime to centralized handlers
    runtime.onEvent((event) => {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    });
    logger.info({ runtimeType: runtime.type }, 'Agent runtime registered');
  }

  /** Bind an agent to a specific runtime (called on agent connect). */
  bindAgent(agentId: string, runtimeType: RuntimeType): void {
    this.agentRuntimeBindings.set(agentId, runtimeType);
    logger.debug({ agentId, runtimeType }, 'Agent bound to runtime');
  }

  /** Unbind an agent from its runtime (called on agent disconnect). */
  unbindAgent(agentId: string): void {
    this.agentRuntimeBindings.delete(agentId);
    logger.debug({ agentId }, 'Agent unbound from runtime');
  }

  /**
   * Resolve which runtime handles a given agent.
   * 1. Check explicit binding table (set by agent-gateway on WS connect)
   * 2. Fall back to probing each runtime via isAgentReachable()
   */
  resolveRuntime(agentId: string): AgentRuntime | null {
    // Check explicit binding first
    const boundType = this.agentRuntimeBindings.get(agentId);
    if (boundType) {
      const runtime = this.runtimes.get(boundType);
      if (runtime) return runtime;
    }

    // Fall back: probe each runtime
    for (const runtime of this.runtimes.values()) {
      if (runtime.isAgentReachable(agentId)) {
        return runtime;
      }
    }

    return null;
  }

  /** Route a message to the correct runtime for an agent. */
  async sendMessage(agentId: string, message: string, conversationId: string): Promise<boolean> {
    const runtime = this.resolveRuntime(agentId);
    if (!runtime) {
      logger.warn({ agentId }, 'No runtime found for agent');
      return false;
    }
    return runtime.sendMessage(agentId, message, conversationId);
  }

  /** Route an approval response to the correct runtime. */
  async sendApprovalResponse(
    agentId: string,
    taskId: string,
    approved: boolean,
    conversationId: string,
    reason?: string,
    edits?: { path: string; content: string }[],
  ): Promise<boolean> {
    const runtime = this.resolveRuntime(agentId);
    if (!runtime) {
      logger.warn({ agentId, taskId }, 'No runtime found for agent approval');
      return false;
    }
    return runtime.sendApprovalResponse(agentId, taskId, approved, conversationId, reason, edits);
  }

  /** Route a command to the correct runtime. */
  async sendCommand(agentId: string, command: string, args?: unknown): Promise<boolean> {
    const runtime = this.resolveRuntime(agentId);
    if (!runtime) {
      logger.warn({ agentId, command }, 'No runtime found for agent command');
      return false;
    }
    return runtime.sendCommand(agentId, command, args);
  }

  /** Dispatch a sub-agent task via the appropriate runtime. */
  async dispatch(
    parentAgentId: string,
    targetSlug: string,
    task: string,
    conversationId: string,
  ): Promise<string | null> {
    const runtime = this.resolveRuntime(parentAgentId);
    if (!runtime?.dispatch) {
      logger.warn({ parentAgentId }, 'No runtime with dispatch support found');
      return null;
    }
    return runtime.dispatch(parentAgentId, targetSlug, task, conversationId);
  }

  /** Subscribe to normalized events from all runtimes. */
  onEvent(handler: NormalizedEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /** Initialize all registered runtimes. */
  async initializeAll(): Promise<void> {
    for (const [type, runtime] of this.runtimes) {
      try {
        await runtime.initialize();
        logger.info({ runtimeType: type }, 'Agent runtime initialized');
      } catch (err) {
        logger.warn({ err, runtimeType: type }, 'Agent runtime initialization failed (will retry)');
      }
    }
  }

  /** Gracefully shut down all runtimes. */
  async shutdownAll(): Promise<void> {
    for (const [type, runtime] of this.runtimes) {
      try {
        await runtime.shutdown();
        logger.info({ runtimeType: type }, 'Agent runtime shut down');
      } catch (err) {
        logger.error({ err, runtimeType: type }, 'Error shutting down agent runtime');
      }
    }
  }
}

export const runtimeManager = new AgentRuntimeManager();
