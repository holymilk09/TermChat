#!/usr/bin/env node

/**
 * termchat-agent CLI
 *
 * Standalone CLI for linking OpenClaw agents to TermChat.
 * Can also be used directly without the OpenClaw framework.
 *
 * Usage:
 *   npx termchat-agent link <PAIRING-CODE>
 *   npx termchat-agent init
 *   npx termchat-agent status
 *   npx termchat-agent unlink
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const CONFIG_DIR = join(homedir(), '.termchat');
const CONFIG_FILE = join(CONFIG_DIR, 'agent.json');
const DEFAULT_API = process.env.TERMCHAT_API_URL || 'https://api.termchat.app';

const args = process.argv.slice(2);
const command = args[0];

// ═══════════════════════════════════════════════════
// CLI Commands
// ═══════════════════════════════════════════════════

async function main() {
  switch (command) {
    case 'link':
      await linkCommand(args[1]);
      break;
    case 'init':
      await initCommand();
      break;
    case 'status':
      await statusCommand();
      break;
    case 'unlink':
      await unlinkCommand();
      break;
    case 'config':
      configCommand();
      break;
    default:
      printUsage();
      break;
  }
}

// ── link <code> ─────────────────────────────────

async function linkCommand(code) {
  if (!code) {
    console.error('Error: Pairing code is required');
    console.error('Usage: termchat-agent link <PAIRING-CODE>');
    process.exit(1);
  }

  console.log('');
  console.log('  TermChat Agent Link');
  console.log('  ───────────────────');
  console.log('');
  process.stdout.write('  Connecting to TermChat... ');

  try {
    const res = await fetch(`${DEFAULT_API}/api/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.trim().toUpperCase(),
        deviceName: `cli-${process.platform}-${process.arch}`,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.log('✗');
      console.error(`\n  Error: ${err.message || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    const result = await res.json();
    console.log('✓');

    // Save config
    saveConfig({
      token: result.token,
      agentId: result.agent.id,
      agentSlug: result.agent.slug,
      agentName: result.agent.name,
      model: result.agent.model,
      owner: result.owner?.username,
      apiUrl: DEFAULT_API,
      gatewayUrl: result.gateway?.url,
      linkedAt: new Date().toISOString(),
    });

    console.log(`  ✓ Agent: ${result.agent.name} (${result.agent.slug})`);
    console.log(`  ✓ Model: ${result.agent.model}`);
    console.log(`  ✓ Owner: @${result.owner?.username}`);
    console.log('');
    console.log('  Agent is now linked. It will appear in TermChat.');
    console.log(`  Config saved to ${CONFIG_FILE}`);
    console.log('');
  } catch (err) {
    console.log('✗');
    console.error(`\n  Network error: ${err.message}`);
    process.exit(1);
  }
}

// ── init ────────────────────────────────────────

async function initCommand() {
  console.log('');
  console.log('  TermChat Agent Setup');
  console.log('  ────────────────────');
  console.log('');

  // Step 1: Request device auth
  process.stdout.write('  Requesting authorization... ');

  const agentName = await ask('  Agent name: ');
  const defaultSlug = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const agentSlug = (await ask(`  Agent slug [${defaultSlug}]: `)) || defaultSlug;

  console.log('');
  console.log('  Select a model:');
  console.log('    1. Claude Sonnet 4.5');
  console.log('    2. Claude Opus 4');
  console.log('    3. Claude Haiku 4.5');
  const modelChoice = await ask('  Choice [1]: ') || '1';
  const model = {
    '1': 'claude-sonnet-4-5-20250929',
    '2': 'claude-opus-4-20250514',
    '3': 'claude-haiku-4-5-20251001',
  }[modelChoice] || 'claude-sonnet-4-5-20250929';

  console.log('');
  process.stdout.write('  Requesting authorization... ');

  try {
    const res = await fetch(`${DEFAULT_API}/api/pairing/device/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentConfig: { name: agentName, slug: agentSlug, model },
      }),
    });

    if (!res.ok) {
      console.log('✗');
      console.error('\n  Failed to start device auth flow');
      process.exit(1);
    }

    const authRequest = await res.json();
    console.log('✓');

    console.log('');
    console.log('  Open this URL on your phone:');
    console.log(`  ${authRequest.verification_url_complete}`);
    console.log('');
    console.log(`  Or enter this code in TermChat: ${authRequest.user_code}`);
    console.log('');
    process.stdout.write('  Waiting for approval... ');

    // Poll for approval
    const result = await pollForToken(authRequest.device_code, authRequest.expires_in);

    if (!result) {
      console.log('✗');
      console.error('\n  Authorization timed out or was denied.');
      process.exit(1);
    }

    console.log('✓');

    // Save config
    saveConfig({
      token: result.token,
      agentId: result.agent.id,
      agentSlug: result.agent.slug,
      agentName: result.agent.name,
      model: result.agent.model,
      owner: result.owner?.username,
      apiUrl: DEFAULT_API,
      gatewayUrl: result.gateway?.url,
      linkedAt: new Date().toISOString(),
    });

    console.log('');
    console.log(`  ✓ Signed in as @${result.owner?.username}`);
    console.log(`  ✓ Agent: ${result.agent.name} (${result.agent.slug})`);
    console.log(`  ✓ Model: ${result.agent.model}`);
    console.log('');
    console.log('  Agent created and connected!');
    console.log(`  View in TermChat: https://termchat.app/agents/${result.agent.slug}`);
    console.log('');
  } catch (err) {
    console.log('✗');
    console.error(`\n  Error: ${err.message}`);
    process.exit(1);
  }
}

// ── status ──────────────────────────────────────

async function statusCommand() {
  const config = loadConfig();

  if (!config) {
    console.log('  No agent linked. Run `termchat-agent link <code>` or `termchat-agent init`.');
    process.exit(0);
  }

  console.log('');
  console.log('  TermChat Agent Status');
  console.log('  ─────────────────────');
  console.log(`  Agent:    ${config.agentName} (${config.agentSlug})`);
  console.log(`  Model:    ${config.model}`);
  console.log(`  Owner:    @${config.owner}`);
  console.log(`  Linked:   ${config.linkedAt}`);
  console.log(`  API:      ${config.apiUrl}`);
  console.log(`  Config:   ${CONFIG_FILE}`);
  console.log('');
}

// ── unlink ──────────────────────────────────────

async function unlinkCommand() {
  const config = loadConfig();

  if (!config) {
    console.log('  No agent linked.');
    process.exit(0);
  }

  try {
    unlinkSync(CONFIG_FILE);
  } catch {
    // Ignore
  }

  console.log(`  ✓ Unlinked agent ${config.agentName} (${config.agentSlug})`);
  console.log('  Config removed.');
}

// ── config ──────────────────────────────────────

function configCommand() {
  const config = loadConfig();
  if (!config) {
    console.log('  No config found.');
    process.exit(0);
  }
  // Redact token for display
  const display = { ...config, token: config.token?.slice(0, 12) + '...' };
  console.log(JSON.stringify(display, null, 2));
}

// ── usage ───────────────────────────────────────

function printUsage() {
  console.log('');
  console.log('  termchat-agent — Connect OpenClaw agents to TermChat');
  console.log('');
  console.log('  Usage:');
  console.log('    termchat-agent link <CODE>   Link agent using pairing code from TermChat app');
  console.log('    termchat-agent init           Set up a new agent (device auth flow)');
  console.log('    termchat-agent status         Show linked agent info');
  console.log('    termchat-agent unlink         Remove agent link');
  console.log('    termchat-agent config         Show config (redacted)');
  console.log('');
}

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function pollForToken(deviceCode, expiresIn) {
  const startTime = Date.now();
  const timeoutMs = expiresIn * 1000;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      const res = await fetch(`${DEFAULT_API}/api/pairing/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });

      if (res.ok) {
        return await res.json();
      }

      const err = await res.json().catch(() => ({}));
      if (err.error === 'authorization_pending') continue;
      if (err.error === 'access_denied') return null;
      if (err.error === 'expired_token') return null;
    } catch {
      // Network error, keep trying
    }
  }

  return null;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
