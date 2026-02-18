import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import * as schema from '../server/db/schema.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://termchat:termchat_dev@localhost:5432/termchat';

async function main() {
  console.log('🌱 Seeding demo data...\n');

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool, { schema });

  // ── Truncate all tables ────────────────────────────
  console.log('Truncating all tables...');
  await db.execute(sql`
    TRUNCATE users, agents, conversations, conversation_members,
             messages, message_status, attachments, agent_sessions,
             agent_tasks, webhooks, pairing_codes, agent_tokens,
             device_auth_requests, cron_jobs
    CASCADE
  `);

  // ── Users ──────────────────────────────────────────
  const passwordHash = await bcrypt.hash('password123', 12);

  const humans = [
    { username: 'alice', displayName: 'Alice', email: 'alice@example.com' },
    { username: 'bob', displayName: 'Bob', email: 'bob@example.com' },
    { username: 'charlie', displayName: 'Charlie', email: 'charlie@example.com' },
    { username: 'sarah', displayName: 'Sarah', email: 'sarah@example.com' },
    { username: 'mike', displayName: 'Mike', email: 'mike@example.com' },
    { username: 'carol', displayName: 'Carol', email: 'carol@example.com' },
  ] as const;

  const userMap: Record<string, typeof schema.users.$inferSelect> = {};
  for (const u of humans) {
    const [row] = await db.insert(schema.users).values({
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      passwordHash,
      status: 'offline',
    }).returning();
    userMap[u.username] = row;
  }
  console.log(`Created ${humans.length} human users`);

  // Bot users
  const bots = [
    { username: 'brain_bot', displayName: 'Brain' },
    { username: 'coder_bot', displayName: 'Coder' },
    { username: 'research_bot', displayName: 'Research' },
  ] as const;

  for (const b of bots) {
    const [row] = await db.insert(schema.users).values({
      username: b.username,
      displayName: b.displayName,
      isBot: true,
      botToken: await bcrypt.hash(`${b.username}_token_${Date.now()}`, 12),
      botOwnerId: userMap.alice.id,
      status: 'offline',
    }).returning();
    userMap[b.username] = row;
  }
  console.log(`Created ${bots.length} bot users`);

  // ── Agents ─────────────────────────────────────────
  const agentDefs = [
    {
      botUsername: 'brain_bot', slug: 'brain', name: 'Brain', icon: '🧠',
      model: 'anthropic/claude-opus-4-6',
      fallbackModels: ['anthropic/claude-sonnet-4-5'],
      scopes: ['read', 'write', 'exec', 'browser'],
      skills: ['orchestration', 'analysis', 'writing', 'memory', 'research'],
      sandbox: 'non-main', heartbeat: '30m', isPrimary: true,
    },
    {
      botUsername: 'coder_bot', slug: 'coder', name: 'Coder', icon: '💻',
      model: 'openai/gpt-5.2-codex',
      fallbackModels: ['openai/gpt-4.1'],
      scopes: ['read', 'write', 'exec'],
      skills: ['coding', 'git', 'testing', 'debugging'],
      sandbox: 'all', heartbeat: '15m', isPrimary: false,
    },
    {
      botUsername: 'research_bot', slug: 'research', name: 'Research', icon: '🔍',
      model: 'google/gemini-2.5-pro',
      fallbackModels: ['google/gemini-2.0-flash'],
      scopes: ['read', 'browser'],
      skills: ['web-search', 'summarization', 'fact-check'],
      sandbox: 'all', heartbeat: '20m', isPrimary: false,
    },
  ] as const;

  const agentMap: Record<string, typeof schema.agents.$inferSelect> = {};
  for (const a of agentDefs) {
    const [row] = await db.insert(schema.agents).values({
      botUserId: userMap[a.botUsername].id,
      ownerId: userMap.alice.id,
      slug: a.slug,
      name: a.name,
      icon: a.icon,
      model: a.model,
      fallbackModels: [...a.fallbackModels],
      scopes: [...a.scopes],
      skills: [...a.skills],
      sandbox: a.sandbox,
      heartbeat: a.heartbeat,
      isPrimary: a.isPrimary,
    }).returning();
    agentMap[a.slug] = row;
  }
  console.log(`Created ${agentDefs.length} agents`);

  // ── Conversations ──────────────────────────────────
  // 1. Brain agent chat
  const [brainChat] = await db.insert(schema.conversations).values({
    type: 'agent',
    name: 'Brain',
    creatorId: userMap.alice.id,
  }).returning();
  await db.insert(schema.conversationMembers).values([
    { conversationId: brainChat.id, userId: userMap.alice.id, role: 'owner' },
    { conversationId: brainChat.id, userId: userMap.brain_bot.id, role: 'bot' },
  ]);

  // 2. alice <-> bob DM
  const [aliceBobDm] = await db.insert(schema.conversations).values({
    type: 'dm',
    creatorId: userMap.alice.id,
  }).returning();
  await db.insert(schema.conversationMembers).values([
    { conversationId: aliceBobDm.id, userId: userMap.alice.id, role: 'owner' },
    { conversationId: aliceBobDm.id, userId: userMap.bob.id, role: 'member' },
  ]);

  // 3. alice <-> carol DM
  const [aliceCarolDm] = await db.insert(schema.conversations).values({
    type: 'dm',
    creatorId: userMap.alice.id,
  }).returning();
  await db.insert(schema.conversationMembers).values([
    { conversationId: aliceCarolDm.id, userId: userMap.alice.id, role: 'owner' },
    { conversationId: aliceCarolDm.id, userId: userMap.carol.id, role: 'member' },
  ]);

  // 4. #backend channel
  const [backendChan] = await db.insert(schema.conversations).values({
    type: 'channel',
    name: '#backend',
    description: 'Backend development discussion',
    creatorId: userMap.alice.id,
    isPublic: true,
  }).returning();
  await db.insert(schema.conversationMembers).values([
    { conversationId: backendChan.id, userId: userMap.alice.id, role: 'owner' },
    { conversationId: backendChan.id, userId: userMap.bob.id, role: 'admin' },
    { conversationId: backendChan.id, userId: userMap.charlie.id, role: 'member' },
    { conversationId: backendChan.id, userId: userMap.sarah.id, role: 'admin' },
    { conversationId: backendChan.id, userId: userMap.mike.id, role: 'member' },
    { conversationId: backendChan.id, userId: userMap.brain_bot.id, role: 'bot' },
  ]);

  // 5. #devops channel
  const [devopsChan] = await db.insert(schema.conversations).values({
    type: 'channel',
    name: '#devops',
    description: 'Infrastructure and deployment',
    creatorId: userMap.alice.id,
    isPublic: true,
  }).returning();
  await db.insert(schema.conversationMembers).values([
    { conversationId: devopsChan.id, userId: userMap.alice.id, role: 'owner' },
    { conversationId: devopsChan.id, userId: userMap.charlie.id, role: 'admin' },
    { conversationId: devopsChan.id, userId: userMap.bob.id, role: 'member' },
  ]);

  // 6. bob <-> charlie DM
  const [bobCharlieDm] = await db.insert(schema.conversations).values({
    type: 'dm',
    creatorId: userMap.bob.id,
  }).returning();
  await db.insert(schema.conversationMembers).values([
    { conversationId: bobCharlieDm.id, userId: userMap.bob.id, role: 'owner' },
    { conversationId: bobCharlieDm.id, userId: userMap.charlie.id, role: 'member' },
  ]);

  console.log('Created 6 conversations');

  // ── Helper: insert messages ────────────────────────
  let totalMessages = 0;
  async function insertMessages(
    conversationId: string,
    msgs: { senderId: string; seq: number; type?: string; content: string; metadata?: Record<string, unknown> }[],
  ) {
    for (const msg of msgs) {
      await db.insert(schema.messages).values({
        conversationId,
        senderId: msg.senderId,
        seq: msg.seq,
        type: msg.type ?? 'text',
        content: msg.content,
        metadata: msg.metadata ?? {},
      });
      totalMessages++;
    }
  }

  // ── Messages: Brain agent chat (~21) ───────────────
  const alice = userMap.alice;
  const brain = userMap.brain_bot;

  await insertMessages(brainChat.id, [
    { senderId: alice.id, seq: 1, content: 'Good morning Brain. What\'s on the agenda today?' },
    {
      senderId: brain.id, seq: 2, type: 'tool', content: 'Running daily briefing...',
      metadata: {
        agentTools: {
          label: 'Daily Briefing',
          model: 'claude-opus-4-6',
          steps: [
            { text: 'Scanning 3 GitHub repos for new PRs and issues', status: 'done' },
            { text: 'Checking CI/CD pipeline status across environments', status: 'done' },
            { text: 'Aggregating Slack mentions from overnight', status: 'done' },
            { text: 'Compiling summary report', status: 'done' },
          ],
        },
        agentCost: '$0.08',
      },
    },
    {
      senderId: brain.id, seq: 3, content:
        '**Daily Briefing — Feb 16, 2026**\n\n' +
        '- **3 new PRs** awaiting review (2 backend, 1 infra)\n' +
        '- PR #247 from Bob: rate limiter refactor — needs your approval\n' +
        '- CI green on main, staging deploy succeeded at 2:14 AM\n' +
        '- Carol mentioned a slow query on the messages table — p95 > 200ms\n' +
        '- No critical alerts overnight',
      metadata: { agentCost: '$0.03' },
    },
    { senderId: alice.id, seq: 4, content: 'Let\'s deal with Bob\'s PR first. Can you get Coder to review it and Research to check if anyone\'s blogged about rate-limiting patterns recently?' },
    {
      senderId: brain.id, seq: 5, type: 'dispatch', content: 'Dispatching parallel tasks to Coder and Research...',
      metadata: {
        dispatch: {
          parallel: true,
          agents: [
            {
              id: 'coder',
              status: 'completed',
              cost: '$0.42',
              task: 'Review PR #247 — rate limiter refactor',
              tools: [
                { text: 'git fetch origin pull/247/head:pr-247', status: 'done' },
                { text: 'Running diff analysis on 4 changed files', status: 'done' },
                { text: 'Executing test suite (38 tests)', status: 'done' },
                { text: 'Static analysis with eslint + tsc', status: 'done' },
              ],
              output: { content: 'PR #247 looks solid. Tests pass. One suggestion: the sliding window should use EVALSHA instead of inline Lua for ~15% less Redis overhead. See code block below.' },
              code: {
                lang: 'typescript',
                file: 'server/middleware/rate-limit.ts',
                content: '- const count = await redis.scriptEval(LUA_SLIDING_WINDOW, 1, key, now, windowMs);\n+ const sha = await redis.scriptLoad(LUA_SLIDING_WINDOW);\n+ const count = await redis.scriptRunSha(sha, 1, key, now, windowMs);',
              },
            },
            {
              id: 'research',
              status: 'completed',
              cost: '$0.18',
              task: 'Find recent blog posts on rate limiting patterns',
              tools: [
                { text: 'Searching HN for "rate limiting" (last 30 days)', status: 'done' },
                { text: 'Fetching top 5 articles', status: 'done' },
                { text: 'Extracting key patterns and benchmarks', status: 'done' },
              ],
              output: { content: 'Found 3 relevant threads:\n1. "Token bucket vs sliding window at scale" (482 pts) — recommends sliding window for API gateways\n2. "Redis rate limiting in 2026" (231 pts) — confirms cached-script approach, notes 20% improvement\n3. "Rate limiting microservices" (189 pts) — suggests adding a local cache layer for hot paths' },
            },
          ],
        },
        agentCost: '$0.64',
      },
    },
    { senderId: alice.id, seq: 6, content: 'Nice finds. The script-caching optimization is exactly what we need. Can you write up that change as a suggestion on the PR?' },
    {
      senderId: brain.id, seq: 7, type: 'code', content: 'Here\'s the suggested diff for the rate limiter:',
      metadata: {
        agentCode: {
          lang: 'typescript',
          file: 'server/middleware/rate-limit.ts',
          content: [
            '// Before: inline script run on every request',
            '- const count = await redis.scriptEval(LUA_SLIDING_WINDOW, 1, key, now, windowMs);',
            '',
            '// After: load script once, use cached SHA for subsequent calls',
            '+ let slidingWindowSha: string | null = null;',
            '+ async function getRateLimitCount(key: string, now: number, windowMs: number) {',
            '+   if (!slidingWindowSha) {',
            '+     slidingWindowSha = await redis.scriptLoad(LUA_SLIDING_WINDOW);',
            '+   }',
            '+   return redis.scriptRunSha(slidingWindowSha, 1, key, now, windowMs);',
            '+ }',
          ].join('\n'),
        },
        agentCost: '$0.02',
      },
    },
    { senderId: alice.id, seq: 8, content: 'Perfect. Go ahead and post that as a review comment, then approve the PR.' },
    {
      senderId: brain.id, seq: 9, type: 'approval', content: 'I\'d like to approve PR #247 and post the review comment. This will:\n\n1. Post an inline suggestion on `server/middleware/rate-limit.ts`\n2. Approve the PR with comment "LGTM with one optimization suggestion"',
      metadata: {
        agentApproval: {
          action: 'Approve PR #247 + post review',
          detail: 'Will approve the pull request and post an inline code suggestion for the script-caching optimization on server/middleware/rate-limit.ts',
        },
      },
    },
    { senderId: alice.id, seq: 10, content: 'Approved. Go ahead.' },
    {
      senderId: brain.id, seq: 11, type: 'tool', content: 'Posting review and approving PR...',
      metadata: {
        agentTools: {
          label: 'GitHub PR Review',
          model: 'claude-opus-4-6',
          steps: [
            { text: 'Posting inline suggestion on rate-limit.ts:47', status: 'done' },
            { text: 'Submitting PR approval with comment', status: 'done' },
          ],
        },
        agentCost: '$0.04',
      },
    },
    { senderId: brain.id, seq: 12, content: 'Done! PR #247 is approved with the optimization suggestion posted. Bob will see the review notification.' },
    { senderId: alice.id, seq: 13, content: 'What about Carol\'s slow query issue?' },
    {
      senderId: brain.id, seq: 14, content:
        'Carol flagged a p95 > 200ms on the messages query. Looking at the schema, the `idx_messages_conv_seq` index covers the primary lookup, ' +
        'but queries filtering by `created_at` range within a conversation aren\'t covered.\n\n' +
        'I\'d suggest a composite index: `(conversation_id, created_at)` — should bring p95 under 20ms for time-range queries.',
      metadata: { agentCost: '$0.05' },
    },
    {
      senderId: brain.id, seq: 15, type: 'code', content: 'Here\'s the migration:',
      metadata: {
        agentCode: {
          lang: 'sql',
          file: 'migrations/0005_add_messages_conv_created_idx.sql',
          content: 'CREATE INDEX CONCURRENTLY idx_messages_conv_created\n  ON messages (conversation_id, created_at DESC);',
        },
        agentCost: '$0.01',
      },
    },
    { senderId: alice.id, seq: 16, content: 'Good call. Let\'s schedule that for the next maintenance window. Also, set up the morning brief as a cron.' },
    {
      senderId: brain.id, seq: 17, content: 'Cron job configured:',
      metadata: {
        agentCron: {
          name: 'morning-brief',
          schedule: '0 8 * * *',
          target: 'brain',
          status: 'active',
        },
        agentCost: '$0.01',
      },
    },
    { senderId: alice.id, seq: 18, content: 'And a weekly dependency scan with Coder?' },
    {
      senderId: brain.id, seq: 19, content: 'Done — weekly dependency scan scheduled:',
      metadata: {
        agentCron: {
          name: 'dependency-scan',
          schedule: '0 6 * * 1',
          target: 'coder',
          status: 'active',
        },
        agentCost: '$0.01',
      },
    },
    { senderId: alice.id, seq: 20, content: 'Great. That\'s a solid morning. Thanks Brain.' },
    {
      senderId: brain.id, seq: 21, content: 'You\'re welcome! Current session cost: **$1.24** (48,200 tokens). I\'ll keep monitoring PRs and will ping you if anything urgent comes up.',
      metadata: { agentCost: '$1.24' },
    },
  ]);

  // ── Messages: alice <-> bob DM (~10) ───────────────
  const screenshotMsgSeq = 7;
  await insertMessages(aliceBobDm.id, [
    { senderId: alice.id, seq: 1, content: 'Hey Bob, Brain just reviewed your PR #247 — looks good with one optimization suggestion.' },
    { senderId: userMap.bob.id, seq: 2, content: 'Oh nice! Let me check. The script-caching approach?' },
    { senderId: alice.id, seq: 3, content: 'Yep. Should be a quick change. Already approved pending that tweak.' },
    { senderId: userMap.bob.id, seq: 4, content: 'Just pushed the update. Tests still green.' },
    { senderId: alice.id, seq: 5, content: 'Perfect. Can you also look at the staging environment? Carol reported slow queries.' },
    { senderId: userMap.bob.id, seq: 6, content: 'Sure. Let me pull up the metrics dashboard.' },
    {
      senderId: userMap.bob.id, seq: screenshotMsgSeq, content: 'Here are the staging screenshots — p95 latency is definitely spiking on the messages endpoint.',
      metadata: { hasAttachments: true },
    },
    { senderId: alice.id, seq: 8, content: 'Yikes, 340ms p95. Brain already suggested a composite index on (conversation_id, created_at).' },
    { senderId: userMap.bob.id, seq: 9, content: 'That makes sense. I\'ll prep the migration for the next maintenance window.' },
    { senderId: alice.id, seq: 10, content: 'Thanks Bob. Let me know when it\'s ready for review.' },
  ]);

  // ── Messages: #backend channel (~12) ───────────────
  await insertMessages(backendChan.id, [
    { senderId: alice.id, seq: 1, type: 'system', content: 'Alice created the channel #backend' },
    { senderId: userMap.sarah.id, seq: 2, content: 'Hey team, let\'s use this channel for all backend discussion. What\'s the status on the API redesign?' },
    { senderId: userMap.bob.id, seq: 3, content: 'Rate limiter PR is in review. Brain already gave feedback — switching to cached script execution for Redis efficiency.' },
    { senderId: userMap.mike.id, seq: 4, content: 'Frontend here — any ETA on the new message pagination endpoint? We need cursor-based pagination for infinite scroll.' },
    { senderId: alice.id, seq: 5, content: 'Bob\'s working on that next. Should have it by Wednesday.' },
    { senderId: userMap.bob.id, seq: 6, content: 'Yeah, I\'ll base it on the (conversation_id, seq) index. Keyset pagination is way faster than OFFSET.' },
    { senderId: userMap.mike.id, seq: 7, content: 'Perfect. Can you also add a `has_more` field in the response? Makes the frontend logic cleaner.' },
    { senderId: userMap.bob.id, seq: 8, content: 'Already planned. Response shape will be `{ messages: [], nextCursor: string | null, hasMore: boolean }`' },
    { senderId: userMap.sarah.id, seq: 9, content: 'Nice. What about the attachment upload flow? Are we going with presigned S3 URLs?' },
    { senderId: alice.id, seq: 10, content: 'Yes. Client gets a presigned PUT URL, uploads directly to S3, then sends the message with the storage key.' },
    { senderId: userMap.charlie.id, seq: 11, content: 'I\'ve set up the S3 bucket with lifecycle rules — 90 day retention on attachments, thumbnails auto-generated via Lambda.' },
    { senderId: userMap.sarah.id, seq: 12, content: 'Great work everyone. Let\'s sync again on Thursday.' },
  ]);

  // ── Messages: #devops channel (~6) ─────────────────
  await insertMessages(devopsChan.id, [
    { senderId: alice.id, seq: 1, type: 'system', content: 'Alice created the channel #devops' },
    { senderId: userMap.charlie.id, seq: 2, content: 'Staging deploy completed successfully at 2:14 AM. All health checks green.' },
    { senderId: userMap.bob.id, seq: 3, content: 'Nice. What\'s our current resource usage on staging?' },
    { senderId: userMap.charlie.id, seq: 4, content: 'CPU: 23%, Memory: 1.2GB/4GB, DB connections: 14/100. Plenty of headroom.' },
    { senderId: alice.id, seq: 5, content: 'We need to plan the production migration for the new schema changes. Charlie, can you draft a runbook?' },
    { senderId: userMap.charlie.id, seq: 6, content: 'On it. I\'ll include rollback steps and the connection draining procedure. ETA tomorrow.' },
  ]);

  // ── Messages: alice <-> carol DM (~6) ──────────────
  await insertMessages(aliceCarolDm.id, [
    { senderId: userMap.carol.id, seq: 1, content: 'Hey Alice, I noticed the messages query is getting slow. p95 is over 200ms for conversations with 10k+ messages.' },
    { senderId: alice.id, seq: 2, content: 'Yeah, Brain flagged that too. We think a composite index on (conversation_id, created_at) will fix it.' },
    { senderId: userMap.carol.id, seq: 3, content: 'That should help. We should also consider partitioning the messages table by month if we expect > 100M rows.' },
    { senderId: alice.id, seq: 4, content: 'Good thinking. Let\'s start with the index and benchmark. If we still need partitioning, we can plan that for v2.' },
    { senderId: userMap.carol.id, seq: 5, content: 'Sounds good. I\'ll prepare the benchmark queries. Also, should we add BRIN indexes for the created_at column?' },
    { senderId: alice.id, seq: 6, content: 'Let\'s test both B-tree and BRIN and compare. Share results in #backend when ready.' },
  ]);

  // ── Messages: bob <-> charlie DM (~4) ──────────────
  await insertMessages(bobCharlieDm.id, [
    { senderId: userMap.bob.id, seq: 1, content: 'Hey Charlie, can you check the Redis cluster? I\'m seeing intermittent connection timeouts on staging.' },
    { senderId: userMap.charlie.id, seq: 2, content: 'Checking now... Looks like one of the replicas had a brief OOM event. Already recovered. I\'ll bump the memory limit.' },
    { senderId: userMap.bob.id, seq: 3, content: 'Thanks. Also, can we set up alerts for Redis memory usage > 80%?' },
    { senderId: userMap.charlie.id, seq: 4, content: 'Done. Added a PagerDuty alert at 80% and a Slack notification at 70%.' },
  ]);

  console.log(`Created ${totalMessages} messages`);

  // ── Attachments ────────────────────────────────────
  // Find the screenshot message (alice<->bob DM, seq 7)
  const screenshotResult = await db.execute(sql`
    SELECT id FROM messages
    WHERE conversation_id = ${aliceBobDm.id} AND seq = ${screenshotMsgSeq}
  `);
  const screenshotMsgId = (screenshotResult.rows[0] as { id: string }).id;

  // Photo attachments on the screenshot message
  await db.insert(schema.attachments).values([
    {
      messageId: screenshotMsgId,
      type: 'photo',
      filename: 'staging-latency-overview.png',
      mimeType: 'image/png',
      sizeBytes: 284_000,
      storageKey: 'attachments/demo/staging-latency-overview.png',
      thumbnailKey: 'attachments/demo/thumbs/staging-latency-overview.png',
      width: 1920,
      height: 1080,
    },
    {
      messageId: screenshotMsgId,
      type: 'photo',
      filename: 'staging-p95-detail.png',
      mimeType: 'image/png',
      sizeBytes: 196_000,
      storageKey: 'attachments/demo/staging-p95-detail.png',
      thumbnailKey: 'attachments/demo/thumbs/staging-p95-detail.png',
      width: 1440,
      height: 900,
    },
    {
      messageId: screenshotMsgId,
      type: 'photo',
      filename: 'staging-db-connections.png',
      mimeType: 'image/png',
      sizeBytes: 152_000,
      storageKey: 'attachments/demo/staging-db-connections.png',
      thumbnailKey: 'attachments/demo/thumbs/staging-db-connections.png',
      width: 1440,
      height: 900,
    },
  ]);

  // File attachments on a bob message in #backend (seq 8)
  const bobMetricsResult = await db.execute(sql`
    SELECT id FROM messages
    WHERE conversation_id = ${backendChan.id} AND seq = 8
  `);
  const bobMetricsMsgId = (bobMetricsResult.rows[0] as { id: string }).id;

  await db.insert(schema.attachments).values([
    {
      messageId: bobMetricsMsgId,
      type: 'file',
      filename: 'deploy-log.txt',
      mimeType: 'text/plain',
      sizeBytes: 45_200,
      storageKey: 'attachments/demo/deploy-log.txt',
    },
    {
      messageId: bobMetricsMsgId,
      type: 'file',
      filename: 'metrics.json',
      mimeType: 'application/json',
      sizeBytes: 12_800,
      storageKey: 'attachments/demo/metrics.json',
    },
  ]);
  console.log('Created 5 attachments');

  // ── Agent Sessions ─────────────────────────────────
  await db.insert(schema.agentSessions).values([
    {
      agentId: agentMap.brain.id,
      conversationId: brainChat.id,
      state: 'active',
      tokensUsed: 48200,
      costUsd: '1.2400',
    },
    {
      agentId: agentMap.coder.id,
      conversationId: brainChat.id,
      state: 'completed',
      tokensUsed: 22100,
      costUsd: '0.6200',
      endedAt: new Date(),
    },
    {
      agentId: agentMap.research.id,
      conversationId: brainChat.id,
      state: 'active',
      tokensUsed: 15700,
      costUsd: '0.3800',
    },
  ]);
  console.log('Created 3 agent sessions');

  // ── Agent Tasks ────────────────────────────────────
  const now = new Date();
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60_000);
  const twentyMinAgo = new Date(now.getTime() - 20 * 60_000);
  const fifteenMinAgo = new Date(now.getTime() - 15 * 60_000);
  const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
  const fiveMinAgo = new Date(now.getTime() - 5 * 60_000);

  await db.insert(schema.agentTasks).values([
    {
      agentId: agentMap.brain.id,
      conversationId: brainChat.id,
      type: 'briefing',
      description: 'Daily morning briefing — scan repos, CI, and mentions',
      status: 'completed',
      input: { repos: ['termchat/termchat', 'termchat/infra', 'termchat/docs'] },
      output: { prCount: 3, ciStatus: 'green', mentionCount: 1 },
      cost: { tokens: 4200, usd: 0.08 },
      startedAt: thirtyMinAgo,
      completedAt: twentyMinAgo,
    },
    {
      agentId: agentMap.coder.id,
      conversationId: brainChat.id,
      type: 'code-review',
      description: 'Review PR #247 — rate limiter refactor',
      status: 'completed',
      input: { pr: 247, repo: 'termchat/termchat' },
      output: { verdict: 'approve', suggestions: 1 },
      cost: { tokens: 18400, usd: 0.42 },
      startedAt: twentyMinAgo,
      completedAt: fifteenMinAgo,
    },
    {
      agentId: agentMap.research.id,
      conversationId: brainChat.id,
      type: 'web-search',
      description: 'Find recent blog posts on rate limiting patterns',
      status: 'in-progress',
      input: { query: 'rate limiting patterns 2026', sources: ['hackernews', 'blogs'] },
      cost: { tokens: 8200, usd: 0.18 },
      startedAt: twentyMinAgo,
    },
    {
      agentId: agentMap.coder.id,
      conversationId: brainChat.id,
      type: 'deploy-watch',
      description: 'Monitor staging deployment health',
      status: 'completed',
      input: { environment: 'staging' },
      output: { healthy: true, duration: '2m14s' },
      cost: { tokens: 1200, usd: 0.03 },
      startedAt: fifteenMinAgo,
      completedAt: tenMinAgo,
    },
    {
      agentId: agentMap.brain.id,
      conversationId: brainChat.id,
      type: 'aggregation',
      description: 'Aggregate dispatch results from Coder and Research',
      status: 'completed',
      input: { dispatchId: 'dispatch-001' },
      output: { agentsCompleted: 2, totalCost: 0.64 },
      cost: { tokens: 2100, usd: 0.04 },
      startedAt: fifteenMinAgo,
      completedAt: tenMinAgo,
    },
    {
      agentId: agentMap.coder.id,
      conversationId: brainChat.id,
      type: 'pr-action',
      description: 'Post review comment and approve PR #247',
      status: 'completed',
      input: { pr: 247, action: 'approve', comment: true },
      output: { reviewId: 'rev-42', approved: true },
      cost: { tokens: 1500, usd: 0.04 },
      startedAt: tenMinAgo,
      completedAt: fiveMinAgo,
    },
  ]);
  console.log('Created 6 agent tasks');

  // ── Cron Jobs ──────────────────────────────────────
  const tomorrow8am = new Date();
  tomorrow8am.setDate(tomorrow8am.getDate() + 1);
  tomorrow8am.setHours(8, 0, 0, 0);

  const nextMonday6am = new Date();
  nextMonday6am.setDate(nextMonday6am.getDate() + ((8 - nextMonday6am.getDay()) % 7 || 7));
  nextMonday6am.setHours(6, 0, 0, 0);

  await db.insert(schema.cronJobs).values([
    {
      agentId: agentMap.brain.id,
      name: 'morning-brief',
      schedule: '0 8 * * *',
      taskType: 'briefing',
      taskConfig: { repos: ['termchat/termchat', 'termchat/infra', 'termchat/docs'], includeCI: true },
      target: 'brain',
      active: true,
      lastRunAt: now,
      nextRunAt: tomorrow8am,
    },
    {
      agentId: agentMap.coder.id,
      name: 'dependency-scan',
      schedule: '0 6 * * 1',
      taskType: 'dependency-audit',
      taskConfig: { repos: ['termchat/termchat'], autoFix: false },
      target: 'coder',
      active: true,
      nextRunAt: nextMonday6am,
    },
  ]);
  console.log('Created 2 cron jobs');

  // ── Agent Tokens ───────────────────────────────────
  const tokenValues = [
    { agentSlug: 'brain', name: 'primary', raw: 'tc_brain_primary_demo_token' },
    { agentSlug: 'brain', name: 'webhook', raw: 'tc_brain_webhook_demo_token' },
    { agentSlug: 'coder', name: 'primary', raw: 'tc_coder_primary_demo_token' },
    { agentSlug: 'research', name: 'primary', raw: 'tc_research_primary_demo_token' },
  ];

  for (const t of tokenValues) {
    await db.insert(schema.agentTokens).values({
      agentId: agentMap[t.agentSlug].id,
      tokenHash: await bcrypt.hash(t.raw, 12),
      name: t.name,
    });
  }
  console.log('Created 4 agent tokens');

  // ── Pairing Codes ─────────────────────────────────
  const tenMinFromNow = new Date(now.getTime() + 10 * 60_000);

  await db.insert(schema.pairingCodes).values([
    {
      code: 'BRAIN-DEMO-4X7K',
      userId: alice.id,
      agentId: agentMap.brain.id,
      status: 'pending',
      expiresAt: tenMinFromNow,
    },
    {
      code: 'CODER-DEMO-9M2R',
      userId: alice.id,
      agentId: agentMap.coder.id,
      status: 'pending',
      expiresAt: tenMinFromNow,
    },
    {
      code: 'RSRCH-DEMO-1P5J',
      userId: alice.id,
      agentId: agentMap.research.id,
      status: 'pending',
      expiresAt: tenMinFromNow,
    },
  ]);
  console.log('Created 3 pairing codes');

  // ── Summary ────────────────────────────────────────
  console.log('\n✅ Demo seed complete!\n');
  console.log('Summary:');
  console.log(`  Users:          9 (6 humans + 3 bots)`);
  console.log(`  Agents:         3 (brain, coder, research)`);
  console.log(`  Conversations:  6 (1 agent, 3 DMs, 2 channels)`);
  console.log(`  Messages:       ${totalMessages}`);
  console.log(`  Attachments:    5`);
  console.log(`  Agent sessions: 3`);
  console.log(`  Agent tasks:    6`);
  console.log(`  Cron jobs:      2`);
  console.log(`  Agent tokens:   4`);
  console.log(`  Pairing codes:  3`);
  console.log('\nCredentials:');
  console.log('  alice / password123   (owner — primary demo account)');
  console.log('  bob / password123     (backend dev)');
  console.log('  charlie / password123 (devops)');
  console.log('  sarah / password123   (team lead)');
  console.log('  mike / password123    (frontend dev)');
  console.log('  carol / password123   (database specialist)');

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
