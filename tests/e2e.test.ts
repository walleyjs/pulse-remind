import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PULSEREMIND_DB_PATH = ':memory:';

const { initDatabase } = await import('../src/pkg/db/bootstrap.ts');
const { watchService } = await import('../src/internal/watch/service.ts');
const { demoPortalService } = await import('../src/internal/demo/service.ts');
const { notificationService } = await import('../src/internal/notification/service.ts');
const { resolutionEngine } = await import('../src/internal/resolution/engine.ts');
const { executeMcpTool, MCP_TOOLS } = await import('../src/pkg/mcp/tools.ts');

initDatabase(true);

test('1. Extracts future-dated scholarship plans from AI chat transcripts ("end of month" & "early next year")', async () => {
  const transcript = `
    User: I am planning my graduate school applications, but the Horizon Global AI Scholarship won't open until the end of this month, and the Oxford Emerging Leaders Fellowship opens early next year.
    Assistant: I will set reminders to monitor both pages and notify you when applications open.
  `;

  const result = (await executeMcpTool('extract_watches_from_chat', {
    transcript,
    auto_create: true,
    recipient_email: 'applicant@example.com'
  })) as {
    success: boolean;
    extracted_opportunities: Array<{ title: string; window_label: string }>;
    created_watches: Array<{ id: string; title: string; status: string }>;
  };

  assert.equal(result.success, true);
  assert.ok(result.extracted_opportunities.length >= 2, 'Should extract both scholarships');
  assert.equal(result.created_watches.length, result.extracted_opportunities.length);
  assert.ok(
    result.extracted_opportunities.some((o) => o.window_label.toLowerCase().includes('end of month')),
    'Should detect End of Month window'
  );
  assert.ok(
    result.extracted_opportunities.some((o) => o.window_label.toLowerCase().includes('early next year')),
    'Should detect Early Next Year window'
  );
});

test('2. MCP tools create watch, detect closed state, and fire multi-channel alerts when portal opens', async () => {
  const toolNames = MCP_TOOLS.map((t) => t.name);
  assert.ok(toolNames.includes('create_opportunity_watch'));
  assert.ok(toolNames.includes('extract_watches_from_chat'));
  assert.ok(toolNames.includes('check_watch_now'));

  // Create watch via MCP tool (Title contains "Global AI" which matches the Horizon Science Foundation portal entity)
  const created = (await executeMcpTool('create_opportunity_watch', {
    title: 'Horizon Global AI Fellowship 2027',
    chat_context: 'User wants to apply for the AI Fellowship when it opens at the end of October.',
    target_url: 'http://localhost:3456/demo/scholarships/global-ai-fellowship',
    timeframe_text: 'end of this month',
    recipient_email: 'winner@university.edu',
    notify_channels: ['in_app', 'email', 'slack']
  })) as {
    success: boolean;
    watch: { id: string };
  };

  assert.equal(created.success, true);
  const watchId = created.watch.id;

  // 1. Check while portal is CLOSED
  const closedCheck = (await executeMcpTool('check_watch_now', {
    watch_id: watchId
  })) as {
    is_open: boolean;
    newly_triggered: boolean;
    notifications_sent: number;
  };
  assert.equal(closedCheck.is_open, false, 'Portal should initially be closed');
  assert.equal(closedCheck.newly_triggered, false);
  assert.equal(closedCheck.notifications_sent, 0);

  // 2. Flip the simulated scholarship portal to OPEN
  demoPortalService.setPortalOpenState('global-ai-fellowship', true);

  // 3. Run check_watch_now and verify detection + multi-channel notification dispatch
  const openCheck = (await executeMcpTool('check_watch_now', {
    watch_id: watchId
  })) as {
    is_open: boolean;
    newly_triggered: boolean;
    detected_deadline: string | null;
    detected_apply_url: string | null;
    notifications_sent: number;
  };

  assert.equal(openCheck.is_open, true, 'Portal should now be detected as OPEN');
  assert.equal(openCheck.newly_triggered, true, 'Should trigger notifications on state transition');
  assert.equal(openCheck.detected_deadline, 'January 15, 2027', 'Should extract deadline from webpage');
  assert.ok(
    openCheck.detected_apply_url?.includes('/demo/scholarships/global-ai-fellowship/apply'),
    'Should extract direct Apply Now link'
  );
  assert.ok(openCheck.notifications_sent >= 3, 'Should dispatch In-App, Email, and Slack alerts');

  // Verify watch status, OracleResponseRecord audit trail, and rendered HTML email
  const allWatches = watchService.listWatches();
  const updatedWatch = allWatches.find((w) => w.id === watchId);
  assert.equal(updatedWatch?.status, 'triggered_open');
  assert.equal(updatedWatch?.proposed_outcome, 1);
  assert.ok((updatedWatch?.oracle_responses.length || 0) >= 2, 'Should record OracleResponseRecord entries');

  const notifs = notificationService.listNotifications().filter((n) => n.watch_id === watchId);
  const emailNotif = notifs.find((n) => n.channel === 'email');
  assert.ok(emailNotif, 'Should store email notification');

  const renderedEmail = notificationService.getRenderedEmailHtml(emailNotif.id);
  assert.ok(renderedEmail?.includes('Horizon Global AI Fellowship 2027'));
  assert.ok(renderedEmail?.includes('January 15, 2027'));
});

test('3. Octopus ResolutionEngine optimizations: 120s Deduplication Cache, Entity Mismatch Guard, and 15m Transient Backoff', async () => {
  // A) Test 120s in-cycle deduplication cache across multiple watches targeting the same portal
  const secondWatchSamePortal = watchService.createWatch({
    title: 'Horizon STEM Doctoral Scholarship 2027',
    chat_context: 'Second watch on the same Horizon portal to verify in-cycle deduplication cache.',
    target_url: 'http://localhost:3456/demo/scholarships/global-ai-fellowship'
  });

  const cachedOutcome = await resolutionEngine.runWatchCheck(secondWatchSamePortal.id);
  assert.ok(cachedOutcome);
  assert.equal(cachedOutcome.evaluation.cacheHit, true, 'Should hit the 120s in-cycle deduplication cache');

  // B) Test Entity Mismatch Guard (watch title "Stanford Medicine Bioethics" pointed at the Horizon AI portal)
  const mismatchedWatch = watchService.createWatch({
    title: 'Stanford Medicine Bioethics Residency',
    chat_context: 'Watch configured with wrong target URL (Entity Mismatch test).',
    target_url: 'http://localhost:3456/demo/scholarships/global-ai-fellowship',
    resolution_config: {
      primary_source_name: 'Stanford Medical School',
      entity_must_match: true
    }
  });

  const mismatchOutcome = await resolutionEngine.runWatchCheck(mismatchedWatch.id);
  assert.ok(mismatchOutcome);
  assert.equal(mismatchOutcome.errorType, 'entity_mismatch');
  assert.equal(mismatchOutcome.watch.status, 'config_error');
  assert.equal(mismatchOutcome.watch.is_auto_resolve, false, 'Should disable is_auto_resolve on entity mismatch');

  // C) Test Transient Network Error Backoff (15m poll_after backoff WITHOUT disabling is_auto_resolve)
  const transientWatch = watchService.createWatch({
    title: 'Unreachable External Portal Scholarship',
    chat_context: 'Simulating transient network or rate limit failure.',
    target_url: 'http://localhost:3456/demo/scholarships/non-existent-portal-slug'
  });

  const nowUnix = Math.floor(Date.now() / 1000);
  const transientOutcome = await resolutionEngine.runWatchCheck(transientWatch.id);
  assert.ok(transientOutcome);
  assert.equal(transientOutcome.errorType, 'transient_backoff');
  assert.equal(
    transientOutcome.watch.is_auto_resolve,
    true,
    'Must NEVER disable is_auto_resolve on transient oracle error'
  );
  assert.ok(
    transientOutcome.watch.poll_after >= nowUnix + 850,
    'Should back off poll_after by ~15 minutes (900s)'
  );
  assert.equal(
    transientOutcome.notificationsDispatched.length,
    0,
    'Must NEVER spam notifications on transient network errors'
  );
});

test('4. MCP stdio server responds to JSON-RPC 2.0 initialize and tools/list over stdin/stdout', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--no-warnings', 'src/pkg/mcp/stdio-server.ts'], {
    env: { ...process.env, PULSEREMIND_DB_PATH: ':memory:' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const responses: Array<Record<string, unknown>> = [];
  let buffer = '';

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP stdio timeout')), 4000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }
      if (responses.length >= 2) {
        clearTimeout(timer);
        child.kill();
        resolve();
      }
    });
  });

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

  await done;
  assert.equal(responses[0].id, 1);
  assert.equal(responses[1].id, 2);
  const tools = (responses[1].result as { tools: Array<{ name: string }> }).tools;
  assert.equal(tools.length, 5);
});

test('5. Server composition root initializes HTTP server and starts/stops background scheduler cleanly', async () => {
  const { createAppServer } = await import('../src/index.ts');
  const server = createAppServer();
  assert.ok(server);
  resolutionEngine.startScheduler(60_000);
  resolutionEngine.startBackgroundScheduler(60_000);
  resolutionEngine.stopScheduler();
});

test('6. PrivacyMinimizer redacts accidental PII while preserving personalized action checklist & claim token', async () => {
  const watch = watchService.createWatch({
    title: 'Horizon Global AI Fellowship 2027',
    chat_context:
      'My name is Jane Doe, phone +1-415-555-0199, passport #A99887766, private@jane.org. Prepare 2-page research proposal and request 2 recommendation letters before end of month.'
  });

  assert.ok(!watch.chat_context.includes('Jane Doe'), 'Should redact personal name statement');
  assert.ok(!watch.chat_context.includes('415-555-0199'), 'Should redact phone number');
  assert.ok(!watch.chat_context.includes('A99887766'), 'Should redact passport/ID number');
  assert.ok(!watch.chat_context.includes('private@jane.org'), 'Should redact embedded email in chat text');
  assert.ok(
    watch.chat_context.includes('Prepare 2-page research proposal'),
    'Should preserve actionable preparation note'
  );

  const meta = watch.resolution_config.provider_metadata;
  assert.ok(meta.subscriber_token?.startsWith('prm_'), 'Should generate opaque subscriber token');
  assert.ok(meta.claim_url?.includes('/claim/prm_'), 'Should generate 1-click out-of-band claim URL');
  assert.ok(Number(meta.pii_redacted_count) >= 4, 'Should track redacted PII count');
});

test('7. Adversarial Real-World HTML Corpus: 0% False Positives on Navbar CTAs, Future Modals, Stale Cohorts & Disabled Links', async () => {
  const adversarialCases: Array<{
    name: string;
    html: string;
    expectedOpen: boolean;
    expectedDeadline?: string;
  }> = [
    {
      name: 'Navbar/Footer False CTA while main scholarship body is closed',
      html: `
        <html><body>
          <nav><a href="/undergrad/apply">Apply Now</a></nav>
          <main>
            <h1>Horizon Global AI Fellowship 2027</h1>
            <p>The 2027 fellowship application portal is currently closed.</p>
          </main>
          <footer><a href="/careers/apply">Submit Application</a></footer>
        </body></html>
      `,
      expectedOpen: false
    },
    {
      name: 'Future-conditional "apply online" modal ("will be able to apply online once...")',
      html: `
        <html><body>
          <main>
            <h1>Horizon Global AI Fellowship 2027</h1>
            <p>Applications will open in November 2026. Candidates will be able to apply online once the portal opens.</p>
          </main>
        </body></html>
      `,
      expectedOpen: false
    },
    {
      name: 'Stale prior-year cohort (2025 open vs 2027 target watch)',
      html: `
        <html><body>
          <main>
            <h1>Horizon Global AI Fellowship</h1>
            <p>Applications are now open for the 2025 cohort! The 2027 cohort is not yet open.</p>
            <a href="/2025/apply">Apply Now</a>
          </main>
        </body></html>
      `,
      expectedOpen: false
    },
    {
      name: 'Disabled / placeholder Apply button (href="#" and aria-disabled="true")',
      html: `
        <html><body>
          <main>
            <h1>Horizon Global AI Fellowship 2027</h1>
            <p>Portal status: Apply online using the button below.</p>
            <a href="#" aria-disabled="true" class="btn disabled">Apply Now</a>
          </main>
        </body></html>
      `,
      expectedOpen: false
    },
    {
      name: 'True 2027 cohort opening with active Apply CTA and deadline',
      html: `
        <html><body>
          <nav><a href="/newsletter">Subscribe</a></nav>
          <main>
            <h1>Horizon Global AI Fellowship 2027</h1>
            <p>Applications are now open for the 2027 cohort! Please submit your application before March 10, 2027.</p>
            <a href="https://horizon.example.org/fellowships/2027/apply" class="btn-primary">Apply Now</a>
          </main>
        </body></html>
      `,
      expectedOpen: true,
      expectedDeadline: 'March 10, 2027'
    }
  ];

  for (const tc of adversarialCases) {
    const w = watchService.createWatch({
      title: 'Horizon Global AI Fellowship 2027',
      chat_context: `Adversarial fixture test: ${tc.name}`,
      target_url: 'https://horizon.example.org/fellowships/global-ai',
      resolution_config: {
        provider_metadata: {
          raw_html_fixture: tc.html
        }
      }
    });

    const outcome = await resolutionEngine.runWatchCheck(w.id);
    assert.ok(outcome, `Outcome should exist for ${tc.name}`);
    assert.equal(
      outcome.evaluation.isOpen,
      tc.expectedOpen,
      `Failed adversarial case "${tc.name}": expected isOpen=${tc.expectedOpen}, got ${outcome.evaluation.isOpen} (${outcome.evaluation.summary})`
    );
    if (tc.expectedDeadline) {
      assert.equal(outcome.evaluation.detectedDeadline, tc.expectedDeadline);
      assert.equal(
        outcome.evaluation.detectedApplyUrl,
        'https://horizon.example.org/fellowships/2027/apply'
      );
    }
    watchService.deleteWatch(w.id);
  }
});

test('8. 150-Subscriber Canonical URL Fan-Out & Idempotent Notification Outbox Benchmark', async () => {
  // Ensure both demo portals are OPEN
  demoPortalService.setPortalOpenState('global-ai-fellowship', true);
  demoPortalService.setPortalOpenState('chevening-emerging-leaders', true);

  const createdIds: string[] = [];
  const utmVariants = [
    '',
    '?utm_source=chatgpt&utm_medium=mcp',
    '/?utm_campaign=fall_2026#apply-section',
    '?fbclid=IwAR123456&ref=claude'
  ];

  for (let i = 0; i < 150; i++) {
    const isChevening = i % 2 === 1;
    const slug = isChevening ? 'chevening-emerging-leaders' : 'global-ai-fellowship';
    const title = isChevening
      ? 'Chevening Emerging Leaders Scholarship 2027'
      : 'Horizon Global AI Fellowship 2027';
    const variant = utmVariants[i % utmVariants.length];

    const w = watchService.createWatch({
      title,
      chat_context: `Subscriber #${i} action item: Prepare 2 academic references.`,
      target_url: `http://localhost:3456/demo/scholarships/${slug}${variant}`,
      notify_channels: ['in_app', 'email'],
      recipient_email: `subscriber_${i}@university.edu`
    });
    createdIds.push(w.id);
  }

  const metrics = await resolutionEngine.runCycleWithMetrics(true);
  assert.ok(metrics.totalWatchesEvaluated >= 150, 'Should evaluate all 150 subscriber watches');
  assert.ok(
    metrics.cacheHits >= 148,
    `Expected >= 148 cache hits across 150 subscribers sharing canonical URLs, got ${metrics.cacheHits}`
  );

  // Verify idempotent notification outbox: re-dispatching open notifications for a triggered watch must produce 0 duplicates
  const sampleWatch = watchService.getWatchById(createdIds[0])!;
  const firstOutcome = await resolutionEngine.runWatchCheck(sampleWatch.id);
  assert.ok(firstOutcome);
  const duplicateAttempt = await notificationService.dispatchOpenNotifications(
    sampleWatch,
    firstOutcome.evaluation
  );
  assert.equal(
    duplicateAttempt.length,
    0,
    'Idempotent notification outbox must prevent duplicate notifications for the same watch & cycle'
  );

  for (const id of createdIds) {
    watchService.deleteWatch(id);
  }
});

test('9. Zero-Friction Implicit Chat Shorthand & Out-of-Band Claim Token Binding', async () => {
  const implicitTranscript =
    "User: Ugh, Fulbright doesn't open until early next year, and Gates Cambridge opens at the end of this month — what should I work on first?";

  const res = (await executeMcpTool('extract_watches_from_chat', {
    transcript: implicitTranscript,
    auto_create: true
  })) as {
    success: boolean;
    extracted_opportunities: Array<{ title: string; target_url: string }>;
    created_watches: Array<{
      id: string;
      title: string;
      resolution_config: { provider_metadata: Record<string, string> };
    }>;
  };

  assert.equal(res.success, true);
  assert.ok(
    res.extracted_opportunities.some((o) => o.title.includes('Fulbright')),
    'Should resolve implicit "Fulbright" mention via Canonical Opportunity Registry'
  );
  assert.ok(
    res.extracted_opportunities.some((o) => o.title.includes('Gates Cambridge')),
    'Should resolve implicit "Gates Cambridge" mention via Canonical Opportunity Registry'
  );

  const createdWatch = res.created_watches[0];
  const token = createdWatch.resolution_config.provider_metadata.subscriber_token;
  assert.ok(token.startsWith('prm_'), 'Should issue anonymous subscriber_token');

  // Out-of-band claim binding (user binds their email & Telegram outside the AI chat)
  const claimed = watchService.claimSubscriberToken(token, {
    recipient_email: 'private_student@cam.ac.uk',
    notify_channels: ['in_app', 'email', 'telegram']
  });
  assert.ok(claimed);
  assert.equal(claimed.recipient_email, 'private_student@cam.ac.uk');
  assert.ok(claimed.notify_channels.includes('telegram'));
  assert.ok(claimed.resolution_config.provider_metadata.claimed_at);
});

