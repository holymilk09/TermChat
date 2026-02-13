/**
 * @termchat/openclaw-provider
 *
 * TermChat messaging provider for OpenClaw.
 * This module implements the OpenClaw provider interface so that
 * TermChat appears as a messaging platform option during `openclaw init`.
 *
 * Usage in OpenClaw's provider registry:
 *   const termchat = require('@termchat/openclaw-provider');
 *   providers.register(termchat);
 *
 * Or standalone:
 *   npx termchat-agent link <PAIRING-CODE>
 *   npx termchat-agent init
 */

import WebSocket from 'ws';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.termchat');
const CONFIG_FILE = join(CONFIG_DIR, 'agent.json');
const DEFAULT_API = 'https://api.termchat.app';

// ═══════════════════════════════════════════════════
// OpenClaw Provider Interface
// ═══════════════════════════════════════════════════

export default {
  name: 'TermChat',
  id: 'termchat',
  description: 'Chat with your AI agents from your phone via TermChat',
  icon: '💬',

  /**
   * Called by OpenClaw during `openclaw init` when user selects TermChat.
   * Handles authentication — either pairing code or device auth flow.
   */
  async auth(context) {
    const { prompt, log } = context;

    log('');
    log('  TermChat — Connect your agent to TermChat');
    log('  ──────────────────────────────────────────');
    log('');

    const method = await prompt.select('How do you want to connect?', [
      { label: 'Pairing code (from TermChat app)', value: 'pairing' },
      { label: 'Sign in from here (device auth)', value: 'device' },
    ]);

    if (method === 'pairing') {
      return await authViaPairingCode(context);
    } else {
      return await authViaDeviceFlow(context);
    }
  },

  /**
   * Called by OpenClaw to send a message from the agent to the user.
   */
  async sendMessage(config, message) {
    const { token, agentId, gatewayUrl } = config;

    const res = await fetch(`${config.apiUrl || DEFAULT_API}/api/bots/api/sendMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: config.conversationId,
        text: message,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to send message: ${res.status}`);
    }

    return await res.json();
  },

  /**
   * Called by OpenClaw to listen for incoming messages from the user.
   * Opens a WebSocket connection to TermChat's agent gateway.
   */
  async onMessage(config, callback) {
    const { token, gatewayUrl } = config;
    const wsUrl = gatewayUrl || 'wss://api.termchat.app/ws/agent';

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    ws.on('open', () => {
      // Authenticate with the gateway
      ws.send(JSON.stringify({
        type: 'auth',
        token,
      }));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === 'message.new' && event.data?.content) {
          callback({
            id: event.data.id,
            text: event.data.content,
            from: {
              id: event.data.senderId,
              username: event.data.sender?.username,
              isBot: event.data.sender?.isBot || false,
            },
            conversationId: event.data.conversationId,
            timestamp: event.data.createdAt,
          });
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      // Reconnect after 3 seconds
      setTimeout(() => {
        config._reconnect?.();
      }, 3000);
    });

    // Return cleanup function
    return () => {
      ws.close();
    };
  },

  /**
   * Load saved config from disk.
   */
  loadConfig() {
    return loadConfig();
  },

  /**
   * Save config to disk.
   */
  saveConfig(config) {
    saveConfig(config);
  },
};

// ═══════════════════════════════════════════════════
// Auth: Pairing Code Flow
// User already created agent in TermChat app
// ═══════════════════════════════════════════════════

async function authViaPairingCode(context) {
  const { prompt, log, spinner } = context;

  const code = await prompt.input('Enter your TermChat pairing code:');

  if (!code || code.trim().length < 4) {
    throw new Error('Invalid pairing code');
  }

  spinner.start('Connecting to TermChat...');

  const apiUrl = getApiUrl();
  const res = await fetch(`${apiUrl}/api/pairing/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: code.trim().toUpperCase(),
      deviceName: `openclaw-${process.platform}`,
    }),
  });

  if (!res.ok) {
    spinner.stop();
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Failed to exchange code (HTTP ${res.status})`);
  }

  const result = await res.json();
  spinner.stop();

  // Save config
  const config = {
    token: result.token,
    agentId: result.agent.id,
    agentSlug: result.agent.slug,
    agentName: result.agent.name,
    model: result.agent.model,
    owner: result.owner?.username,
    apiUrl,
    gatewayUrl: result.gateway?.url,
    linkedAt: new Date().toISOString(),
  };

  saveConfig(config);

  log('');
  log(`  ✓ Authenticated with TermChat`);
  log(`  ✓ Agent: ${result.agent.name} (${result.agent.slug})`);
  log(`  ✓ Model: ${result.agent.model}`);
  log(`  ✓ Owner: @${result.owner?.username}`);
  log('');

  return config;
}

// ═══════════════════════════════════════════════════
// Auth: Device Auth Flow
// Terminal-first — user approves on phone
// ═══════════════════════════════════════════════════

async function authViaDeviceFlow(context) {
  const { prompt, log, spinner } = context;

  const agentName = await prompt.input('Agent name:');
  const agentSlug = await prompt.input('Agent slug:', {
    default: agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
  });
  const model = await prompt.select('Model:', [
    { label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5-20250929' },
    { label: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
    { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  ]);

  spinner.start('Requesting authorization...');

  const apiUrl = getApiUrl();
  const res = await fetch(`${apiUrl}/api/pairing/device/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentConfig: {
        name: agentName,
        slug: agentSlug,
        model,
      },
    }),
  });

  if (!res.ok) {
    spinner.stop();
    throw new Error('Failed to start device auth flow');
  }

  const authRequest = await res.json();
  spinner.stop();

  log('');
  log('  Open this URL on your phone to approve:');
  log(`  ${authRequest.verification_url_complete}`);
  log('');
  log(`  Or enter code manually: ${authRequest.user_code}`);
  log('');

  spinner.start('Waiting for approval...');

  // Poll for approval
  const config = await pollForApproval(apiUrl, authRequest.device_code, authRequest.expires_in);

  spinner.stop();

  if (!config) {
    throw new Error('Authorization timed out or was denied');
  }

  // Save config
  const savedConfig = {
    token: config.token,
    agentId: config.agent.id,
    agentSlug: config.agent.slug,
    agentName: config.agent.name,
    model: config.agent.model,
    owner: config.owner?.username,
    apiUrl,
    gatewayUrl: config.gateway?.url,
    linkedAt: new Date().toISOString(),
  };

  saveConfig(savedConfig);

  log('');
  log(`  ✓ Signed in as @${config.owner?.username}`);
  log(`  ✓ Agent: ${config.agent.name} (${config.agent.slug})`);
  log(`  ✓ Model: ${config.agent.model}`);
  log('');

  return savedConfig;
}

async function pollForApproval(apiUrl, deviceCode, expiresIn) {
  const startTime = Date.now();
  const timeoutMs = expiresIn * 1000;
  const interval = 5000; // 5 seconds

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const res = await fetch(`${apiUrl}/api/pairing/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });

      if (res.ok) {
        return await res.json();
      }

      const err = await res.json().catch(() => ({}));

      if (err.error === 'authorization_pending') {
        continue; // Keep polling
      }

      if (err.error === 'access_denied') {
        return null;
      }

      if (err.error === 'expired_token') {
        return null;
      }
    } catch {
      // Network error, keep trying
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════
// Config File Management
// ═══════════════════════════════════════════════════

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // Ignore
  }
  return null;
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function getApiUrl() {
  return process.env.TERMCHAT_API_URL || DEFAULT_API;
}
