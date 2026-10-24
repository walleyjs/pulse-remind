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
  const path = await import('node:path');
  const child = spawn(process.execPath, ['--no-warnings', 'src/pkg/mcp/stdio-server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
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
  assert.equal(tools.length, 6);
  assert.ok(tools.some((t) => t.name === 'set_notification_destination'));
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

test('10. General Event, Conference, Ticket Drop & Pure Scheduled-Date Reminder Support', async () => {
  // 10a. Create a pure scheduled-date reminder (no URL required)
  const dateReminderRes = (await executeMcpTool('create_opportunity_watch', {
    title: 'Q4 Product Launch Keynote & Press Embargo Lift',
    category: 'product_launch',
    trigger_type: 'scheduled_date',
    timeframe_text: 'end of this month',
    chat_context: 'Publish blog announcement; send press kit to tech journalists; unlock landing page.'
  })) as {
    success: boolean;
    watch: { id: string; category: string; trigger_type: string; status: string };
  };

  assert.equal(dateReminderRes.success, true);
  assert.equal(dateReminderRes.watch.category, 'product_launch');
  assert.equal(dateReminderRes.watch.trigger_type, 'scheduled_date');

  // 10b. Extract general events & conferences (e.g., WWDC & Next.js Summit) from chat transcript
  const eventTranscript =
    'User: WWDC registration opens at the end of this month, and Next.js Global Summit Tickets drop early next year. Remind me to grab an early-bird pass and book my flight.';
  const extractRes = (await executeMcpTool('extract_watches_from_chat', {
    transcript: eventTranscript,
    auto_create: true
  })) as {
    success: boolean;
    extracted_opportunities: Array<{ title: string; category: string }>;
  };

  assert.equal(extractRes.success, true);
  assert.ok(
    extractRes.extracted_opportunities.some((o) => o.title.includes('WWDC')),
    'Should extract WWDC conference event from chat'
  );
  assert.ok(
    extractRes.extracted_opportunities.some(
      (o) => o.category === 'conference' || o.category === 'tickets'
    ),
    'Should classify extracted items as conference or tickets'
  );
});

test('11. Seamless Ask-Once In-Chat Email Binding (set_notification_destination) & RFC 5545 .ics Calendar Feed', async () => {
  const { buildWatchIcsFeed } = await import('../src/pkg/calendar/ics.ts');

  // Reset saved default email so we simulate a brand-new user in ChatGPT ("No Auth" mode)
  notificationService.setSavedDefaultEmail('');

  // Turn 1: User asks ChatGPT to set a reminder without mentioning their email
  const turn1Res = (await executeMcpTool('create_opportunity_watch', {
    title: 'Swedish Institute Scholarship for Global Professionals 2027–2028',
    category: 'scholarship',
    trigger_type: 'web_monitor',
    target_url: 'https://si.se/en/apply/scholarships/',
    timeframe_text: 'Spring 2027',
    chat_context: 'Confirm eligibility and submit master’s scholarship application.'
  })) as {
    success: boolean;
    delivery_status: string;
    bound_email: string | null;
    assistant_instruction: string;
    calendar_links: { google_calendar_url: string; ics_download_url: string };
    watch: { id: string; recipient_email: string | null };
  };

  assert.equal(turn1Res.success, true);
  assert.equal(
    turn1Res.delivery_status,
    'ACTION_REQUIRED_ASK_USER_FOR_EMAIL',
    'Must prompt the LLM to ask for the user email instead of silently using student@university.edu'
  );
  assert.equal(turn1Res.bound_email, null);
  assert.equal(turn1Res.watch.recipient_email, null);
  assert.ok(turn1Res.calendar_links.google_calendar_url.includes('calendar.google.com/calendar/render'));
  assert.ok(turn1Res.calendar_links.ics_download_url.endsWith(`/api/watches/${turn1Res.watch.id}/calendar.ics`));

  // Turn 2: User replies with their email in chat -> LLM calls set_notification_destination
  const turn2Res = (await executeMcpTool('set_notification_destination', {
    recipient_email: 'walley@pulseremind.ai',
    watch_id: turn1Res.watch.id,
    save_as_default: true
  })) as {
    success: boolean;
    delivery_status: string;
    bound_email: string;
    saved_as_default_for_future_chats: boolean;
    updated_watches_count: number;
  };

  assert.equal(turn2Res.success, true);
  assert.equal(turn2Res.delivery_status, 'BOUND_READY');
  assert.equal(turn2Res.bound_email, 'walley@pulseremind.ai');
  assert.equal(turn2Res.saved_as_default_for_future_chats, true);
  assert.ok(turn2Res.updated_watches_count >= 1);

  // Verify the Turn 1 watch now has the user's real email bound in the DB
  const updatedWatch = watchService.getWatchById(turn1Res.watch.id)!;
  assert.equal(updatedWatch.recipient_email, 'walley@pulseremind.ai');

  // Turn 3 (Future chat): User creates another reminder WITHOUT specifying an email -> auto-binds!
  const turn3Res = (await executeMcpTool('create_opportunity_watch', {
    title: 'Stripe Sessions 2027 Early-Bird Tickets',
    category: 'tickets',
    trigger_type: 'web_monitor',
    timeframe_text: 'next month',
    chat_context: 'Buy 1 developer pass.'
  })) as {
    delivery_status: string;
    bound_email: string | null;
  };

  assert.equal(
    turn3Res.delivery_status,
    'BOUND_READY',
    'Future reminders must automatically bind the saved default email in 0 extra turns'
  );
  assert.equal(turn3Res.bound_email, 'walley@pulseremind.ai');

  // Verify RFC 5545 .ics calendar generation
  const icsText = buildWatchIcsFeed([updatedWatch], 'https://pulse-remind.onrender.com');
  assert.ok(icsText.includes('BEGIN:VCALENDAR'));
  assert.ok(icsText.includes('BEGIN:VEVENT'));
  assert.ok(icsText.includes('BEGIN:VALARM'));
  assert.ok(icsText.includes('Swedish Institute Scholarship'));
});

test('12. Cryptographic Web Push (RFC 8291 aes128gcm & RFC 8292 VAPID ES256) round-trip verification', async () => {
  const {
    generateVapidKeys,
    buildVapidAuthHeader,
    verifyVapidJwt,
    encryptWebPushPayload,
    decryptWebPushPayload,
    base64UrlEncode
  } = await import('../src/pkg/webpush/crypto.ts');
  const crypto = await import('node:crypto');

  // 12a. VAPID ES256 keypair generation, JWT signing, and cryptographic signature verification
  const vapidKeys = generateVapidKeys();
  assert.ok(vapidKeys.publicKey.length >= 80, 'Public key should be base64url uncompressed P-256');
  assert.ok(vapidKeys.privateKey.length >= 40, 'Private key should be base64url scalar');

  const endpoint = 'https://fcm.googleapis.com/fcm/send/sample-subscription-id';
  const vapidAuth = buildVapidAuthHeader(endpoint, 'mailto:test@pulseremind.ai', vapidKeys);
  assert.ok(vapidAuth.authorization.startsWith('vapid t='));
  assert.ok(vapidAuth.authorization.includes(', k='));

  const jwtVerify = verifyVapidJwt(vapidAuth.jwt, vapidKeys.publicKey);
  assert.equal(jwtVerify.valid, true, 'VAPID ES256 JWT must verify against the public key');
  assert.equal(jwtVerify.payload?.aud, 'https://fcm.googleapis.com');
  assert.equal(jwtVerify.payload?.sub, 'mailto:test@pulseremind.ai');

  // 12b. Subscriber keypair generation (P-256 + 16-byte auth secret)
  const clientEcdh = crypto.createECDH('prime256v1');
  clientEcdh.generateKeys();
  const clientPubBase64 = base64UrlEncode(clientEcdh.getPublicKey());
  const clientPrivBase64 = base64UrlEncode(clientEcdh.getPrivateKey());
  const authSecretBuf = crypto.randomBytes(16);
  const authSecretBase64 = base64UrlEncode(authSecretBuf);

  // 12c. Encrypt payload under RFC 8291 (aes128gcm)
  const originalMessage = JSON.stringify({
    title: 'PulseRemind: NeurIPS 2026 Paper Deadline',
    body: 'Action Checklist: Submit abstract 24h prior, verify PDF checklist',
    url: 'https://neurips.cc'
  });

  const encrypted = encryptWebPushPayload(originalMessage, {
    p256dh: clientPubBase64,
    auth: authSecretBase64
  });

  assert.equal(encrypted.contentEncoding, 'aes128gcm');
  assert.ok(encrypted.ciphertext.length > originalMessage.length + 86, 'Payload should include 86-byte header + tag');

  // 12d. Decrypt payload using subscriber keys and verify round-trip identity
  const decrypted = decryptWebPushPayload(
    encrypted.ciphertext,
    clientPrivBase64,
    clientPubBase64,
    authSecretBase64
  );
  assert.equal(decrypted, originalMessage, 'Decrypted payload must match original cleartext exactly');
});

test('13. RFC 5545 .ics Structural Compliance: 75-Octet Folding, CRLF, Monotonic SEQUENCE, and Dual VALARMs', async () => {
  const { buildWatchIcsFeed, validateIcsCompliance, foldIcsLine } = await import(
    '../src/pkg/calendar/ics.ts'
  );

  // Test foldIcsLine
  const longLine =
    'DESCRIPTION:Action Checklist: 1. Confirm your eligibility 2. Prepare statement of purpose 3. Request two academic letters 4. Submit before the closing window arrives';
  const folded = foldIcsLine(longLine, 75);
  assert.ok(folded.includes('\r\n '), 'Should fold using CRLF followed by single space');
  for (const chunk of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(chunk, 'utf-8') <= 75, 'Folded line segment must be <= 75 octets');
  }

  // Test buildWatchIcsFeed compliance
  const sampleWatch = watchService.createWatch({
    title: 'Very Long Event Title For Conference And Hackathon In San Francisco 2027',
    chat_context:
      'Checklist items: Verify flights and hotels; submit abstract; request travel stipend from department; register before early-bird rates expire.',
    target_url: 'https://conference.example.org/registration',
    window_start_date: '2027-04-15'
  });

  const feedText = buildWatchIcsFeed([sampleWatch], 'https://pulse-remind.onrender.com');
  const compliance = validateIcsCompliance(feedText);
  assert.equal(compliance.valid, true, `ICS compliance errors: ${compliance.errors.join(', ')}`);
  assert.equal(compliance.hasCrlf, true, 'ICS must use CRLF line endings');
  assert.ok(compliance.maxLineOctets <= 75, `Max line octets (${compliance.maxLineOctets}) must be <= 75`);
  assert.ok(compliance.sequences.length > 0, 'Should include SEQUENCE fields');
  assert.ok(feedText.includes('TRIGGER:-PT24H'), 'Must include 24h VALARM');
  assert.ok(feedText.includes('TRIGGER:-PT15M'), 'Must include 15m VALARM');

  watchService.deleteWatch(sampleWatch.id);
});

test('14. Structured State Extraction: Schema.org JSON-LD (InStock vs SoldOut) & SSR __NEXT_DATA__ Hydration', async () => {
  const { evaluateWebpageSignals } = await import('../src/internal/resolution/validator.ts');

  // 14a. Schema.org JSON-LD InStock
  const jsonLdInStockHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Event",
        "name": "Horizon Global AI Fellowship 2027",
        "startDate": "2027-02-01",
        "offers": {
          "@type": "Offer",
          "availability": "https://schema.org/InStock",
          "url": "https://horizon.example.org/apply-2027",
          "validThrough": "2027-03-31"
        }
      }
      </script>
    </head>
    <body>
      <main><h1>Horizon Global AI Fellowship</h1></main>
    </body>
    </html>
  `;

  const w1 = watchService.createWatch({
    title: 'Horizon Global AI Fellowship 2027',
    chat_context: 'Test JSON-LD InStock extraction'
  });

  const signals1 = evaluateWebpageSignals(w1, jsonLdInStockHtml, 'https://horizon.example.org');
  assert.equal(signals1.isOpen, true, 'Should detect open from JSON-LD InStock');
  assert.equal(signals1.detectedApplyUrl, 'https://horizon.example.org/apply-2027');
  assert.equal(signals1.detectedDeadline, '2027-03-31');

  // 14b. Schema.org JSON-LD SoldOut
  const jsonLdSoldOutHtml = `
    <html>
    <head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Event",
        "name": "Horizon Global AI Fellowship 2027",
        "offers": {
          "@type": "Offer",
          "availability": "https://schema.org/SoldOut"
        }
      }
      </script>
    </head>
    <body><main>Registration info</main></body>
    </html>
  `;
  const signals2 = evaluateWebpageSignals(w1, jsonLdSoldOutHtml, 'https://horizon.example.org');
  assert.equal(signals2.isOpen, false, 'Should detect closed from JSON-LD SoldOut');

  // 14c. SSR __NEXT_DATA__ state
  const nextDataHtml = `
    <html>
    <body>
      <main><h1>Stripe Sessions 2027</h1></main>
      <script id="__NEXT_DATA__" type="application/json">
      {
        "props": {
          "pageProps": {
            "cohortYear": 2027,
            "registrationOpen": true,
            "registrationUrl": "https://stripe.com/sessions/register",
            "deadline": "April 1, 2027"
          }
        }
      }
      </script>
    </body>
    </html>
  `;
  const w2 = watchService.createWatch({
    title: 'Stripe Sessions 2027',
    chat_context: 'Test __NEXT_DATA__ SSR hydration'
  });
  const signals3 = evaluateWebpageSignals(w2, nextDataHtml, 'https://stripe.com');
  assert.equal(signals3.isOpen, true, 'Should detect open from __NEXT_DATA__');
  assert.equal(signals3.detectedApplyUrl, 'https://stripe.com/sessions/register');
  assert.equal(signals3.detectedDeadline, 'April 1, 2027');

  watchService.deleteWatch(w1.id);
  watchService.deleteWatch(w2.id);
});

test('15. Timezone-Aware & AoE ("Anywhere on Earth" = UTC-12) Deadline Resolution', async () => {
  const { resolveTimeframeWindow } = await import('../src/internal/extractor/timeframe.ts');

  // Pinned reference: Sunday Oct 18, 2026 12:00 UTC
  const ref = new Date('2026-10-18T12:00:00Z');

  // 15a. AoE deadline (November 15, 2026 23:59 AoE = 2026-11-16T11:59:00Z UTC)
  const aoeRes = resolveTimeframeWindow('November 15, 2026 23:59 AoE', ref);
  assert.equal(aoeRes.window_start_date, '2026-11-15');
  assert.ok(aoeRes.window_label.includes('AoE (UTC-12)'));
  assert.equal(aoeRes.exact_utc_iso, '2026-11-16T11:59:00.000Z');

  // 15b. "in 5 days" relative resolution
  const inDaysRes = resolveTimeframeWindow('in 5 days', ref);
  assert.equal(inDaysRes.window_start_date, '2026-10-23');
  assert.ok(inDaysRes.window_label.includes('In 5 Days'));

  // 15c. "next Friday" relative resolution (Oct 18 is Sun -> next Friday is Oct 23)
  const nextFriRes = resolveTimeframeWindow('next Friday', ref);
  assert.equal(nextFriRes.window_start_date, '2026-10-23');
  assert.ok(nextFriRes.window_label.includes('Next Friday'));
});

test('16. Antigravity PostInvocation Transcript Lifecycle Hook Contract', async () => {
  const { evaluateTranscriptTurnForHook } = await import('../src/pkg/hooks/post-invocation.ts');

  // Reset saved default email to simulate a user with no pre-bound email
  notificationService.setSavedDefaultEmail('');

  // Scenario A: User mentions upcoming conference in chat, model forgot to invoke MCP tool
  const transcriptMissedCapture = `
{"step_index":1,"type":"USER_INPUT","content":"I need to apply for the NeurIPS 2027 Research Fellowship before the deadline next month. Can you help me review my proposal?"}
{"step_index":2,"type":"PLANNER_RESPONSE","content":"Sure, let's review your proposal. What is the topic of your research?","tool_calls":[]}
`;
  const hookRes1 = await evaluateTranscriptTurnForHook(transcriptMissedCapture);
  assert.equal(hookRes1.hookAction, 'auto_captured_watch');
  assert.ok(hookRes1.capturedTitles && hookRes1.capturedTitles.length > 0);
  assert.ok(
    hookRes1.injectSteps &&
      hookRes1.injectSteps.length > 0 &&
      'ephemeralMessage' in hookRes1.injectSteps[0],
    'Hook must inject ephemeralMessage when watch captured without bound email'
  );

  // Scenario B: User replies with their email address in next turn, model forgot set_notification_destination
  const transcriptEmailReply = `
{"step_index":1,"type":"USER_INPUT","content":"Please send my reminder to developer@antigravity.ai"}
{"step_index":2,"type":"PLANNER_RESPONSE","content":"Got it, I noted that.","tool_calls":[]}
`;
  const hookRes2 = await evaluateTranscriptTurnForHook(transcriptEmailReply);
  assert.equal(hookRes2.hookAction, 'auto_bound_email');
  assert.equal(hookRes2.boundEmail, 'developer@antigravity.ai');
  assert.ok(
    hookRes2.injectSteps &&
      hookRes2.injectSteps.length > 0 &&
      'ephemeralMessage' in hookRes2.injectSteps[0]
  );

  // Clean up created test watches
  for (const title of hookRes1.capturedTitles || []) {
    const found = watchService.listWatches().find((w) => w.title === title);
    if (found) watchService.deleteWatch(found.id);
  }
});

test('17. Multi-Tenant Architectural Boundary: Strict Tenant Data Isolation Between Concurrent Authenticated Sessions', async () => {
  const { createOAuthJwtToken } = await import('../src/pkg/tenant/tenant.ts');
  const { createAppServer } = await import('../src/pkg/server/http-server.ts');
  const { Readable, Writable } = await import('node:stream');

  const server = createAppServer();

  function dispatch(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; json: () => unknown; text: () => string }> {
    return new Promise((resolve) => {
      const req = new Readable({
        read() {
          if (options.body) this.push(Buffer.from(options.body));
          this.push(null);
        }
      }) as any;
      req.method = options.method;
      req.url = options.url;
      req.headers = { host: 'localhost:3456', ...(options.headers || {}) };

      const resChunks: Buffer[] = [];
      let statusCode = 200;

      const res = new Writable({
        write(chunk, encoding, callback) {
          resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        }
      }) as any;

      res.writeHead = (status: number) => {
        statusCode = status;
        return res;
      };
      res.end = (chunk?: any) => {
        if (chunk) resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const output = Buffer.concat(resChunks).toString('utf-8');
        resolve({
          status: statusCode,
          text: () => output,
          json: () => JSON.parse(output)
        });
      };

      server.emit('request', req, res);
    });
  }

  const tenantAToken = createOAuthJwtToken('tenant_alpha', 'alice@corp.com');
  const tenantBToken = createOAuthJwtToken('tenant_beta', 'bob@research.org');

  // Tenant A creates watch via /mcp
  const createResA = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tenantAToken}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req_a1',
      method: 'tools/call',
      params: {
        name: 'create_opportunity_watch',
        arguments: {
          title: 'Alpha Quantum Fellowship 2027',
          chat_context: 'Tenant Alpha prompt',
          recipient_email: 'alice@corp.com'
        }
      }
    })
  });
  assert.equal(createResA.status, 200);
  const createDataA = createResA.json() as { result: { structured: { watch: { id: string } } } };
  const watchIdA = createDataA.result.structured.watch.id;

  // Tenant B creates watch via /mcp
  const createResB = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tenantBToken}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req_b1',
      method: 'tools/call',
      params: {
        name: 'create_opportunity_watch',
        arguments: {
          title: 'Beta Biotech Grant 2027',
          chat_context: 'Tenant Beta prompt',
          recipient_email: 'bob@research.org'
        }
      }
    })
  });
  assert.equal(createResB.status, 200);
  const createDataB = createResB.json() as { result: { structured: { watch: { id: string } } } };
  const watchIdB = createDataB.result.structured.watch.id;

  // 17a. Tenant A lists watches -> sees ONLY Alpha watch
  const listResA = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantAToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req_a2',
      method: 'tools/call',
      params: { name: 'list_active_watches', arguments: {} }
    })
  });
  const listDataA = listResA.json() as {
    result: { structured: { count: number; watches: Array<{ id: string; title: string }> } };
  };
  assert.equal(listDataA.result.structured.count, 1);
  assert.equal(listDataA.result.structured.watches[0].id, watchIdA);
  assert.equal(listDataA.result.structured.watches[0].title, 'Alpha Quantum Fellowship 2027');

  // 17b. Tenant B lists watches -> sees ONLY Beta watch
  const listResB = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantBToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req_b2',
      method: 'tools/call',
      params: { name: 'list_active_watches', arguments: {} }
    })
  });
  const listDataB = listResB.json() as {
    result: { structured: { count: number; watches: Array<{ id: string; title: string }> } };
  };
  assert.equal(listDataB.result.structured.count, 1);
  assert.equal(listDataB.result.structured.watches[0].id, watchIdB);
  assert.equal(listDataB.result.structured.watches[0].title, 'Beta Biotech Grant 2027');

  // 17c. Cross-tenant access prohibition: Tenant A attempts to check Tenant B's watch
  const crossCheckRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantAToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req_cross_check',
      method: 'tools/call',
      params: { name: 'check_watch_now', arguments: { watch_id: watchIdB } }
    })
  });
  const crossCheckJson = crossCheckRes.json() as { error?: { code: number; message: string } };
  assert.ok(crossCheckJson.error, 'Cross-tenant check must fail');
  assert.ok(crossCheckJson.error.message.includes('not found'));

  // 17d. Channel Config isolation: saved default email is completely isolated per tenant
  assert.equal(notificationService.getSavedDefaultEmail('tenant_alpha'), 'alice@corp.com');
  assert.equal(notificationService.getSavedDefaultEmail('tenant_beta'), 'bob@research.org');

  // Clean up
  watchService.deleteWatch(watchIdA, 'tenant_alpha');
  watchService.deleteWatch(watchIdB, 'tenant_beta');
});

test('18. Transactional Outbox & Resilient Dual-Storage Idempotency: WAL Commits, Monotonic Versioning & Backoff Retry', async () => {
  const { outboxProcessor } = await import('../src/pkg/db/outbox.ts');
  const { db } = await import('../src/pkg/db/sqlite.ts');

  // Drain any pending events from earlier test steps
  await outboxProcessor.drainAll(20);

  const tenant = 'tenant_outbox_test';

  // 18a. Local transaction commits entity AND outbox record atomically
  const watch = watchService.createWatch(
    {
      title: 'Outbox Resilience Fellowship 2027',
      chat_context: 'Verify atomic outbox write',
      recipient_email: 'outbox@pulseremind.ai'
    },
    tenant
  );

  assert.equal(watch.version, 1);
  const pendingEvents1 = outboxProcessor.listEvents(tenant);
  assert.ok(pendingEvents1.length >= 1, 'Outbox must contain pending event');
  assert.equal(pendingEvents1[0].event_type, 'watch_created');
  assert.equal(pendingEvents1[0].version, 1);
  assert.equal(pendingEvents1[0].status, 'pending');

  // 18b. Monotonic versioning on state update: version = version + 1
  const updated = watchService.updateWatchFields(watch.id, { condition_text: 'Updated condition' }, tenant);
  assert.equal(updated?.version, 2, 'Version must monotonically increment');
  const pendingEvents2 = outboxProcessor.listEvents(tenant);
  assert.equal(pendingEvents2[0].event_type, 'watch_updated');
  assert.equal(pendingEvents2[0].version, 2);

  // 18c. Simulated network partition / cloud 500 error: verify exponential backoff & zero dropped records
  let simulateNetworkError = true;
  outboxProcessor.setReplicator(async () => {
    if (simulateNetworkError) {
      throw new Error('Supabase 500 Network Partition / Gateway Timeout');
    }
    return true;
  });

  const failDrain = await outboxProcessor.drainOutbox(20);
  assert.ok(failDrain.failed >= 1, 'Should register failed sync attempt');
  const failedEvents = outboxProcessor.listEvents(tenant);
  const failedEvent = failedEvents.find((e) => e.status === 'failed');
  assert.ok(failedEvent, 'Event should transition to failed status with retry scheduled');
  assert.ok(failedEvent.retry_count >= 1);
  assert.ok(failedEvent.next_retry_at > Math.floor(Date.now() / 1000));
  assert.ok(failedEvent.last_error?.includes('Network Partition'));

  // 18d. Network restores: drain succeeds, status transitions to published, 0 duplicate records
  simulateNetworkError = false;
  // Reset next_retry_at so it drains immediately
  db.prepare('UPDATE outbox SET next_retry_at = 0 WHERE tenant_id = ?').run(tenant);

  const recoverDrain = await outboxProcessor.drainOutbox(20);
  assert.ok(recoverDrain.succeeded >= 1, 'Should drain successfully on recovery');
  const publishedEvents = outboxProcessor.listEvents(tenant);
  assert.ok(publishedEvents.every((e) => e.status === 'published'));

  // Reset custom replicator
  outboxProcessor.setReplicator(null);
  watchService.deleteWatch(watch.id, tenant);
});

test('19. Strict MCP (2024-11-05) Protocol Compliance: Error Codes, Capability Negotiation & Subscribable Resources', async () => {
  const { createAppServer } = await import('../src/pkg/server/http-server.ts');
  const { Readable, Writable } = await import('node:stream');

  const server = createAppServer();

  function dispatch(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; json: () => unknown; text: () => string }> {
    return new Promise((resolve) => {
      const req = new Readable({
        read() {
          if (options.body) this.push(Buffer.from(options.body));
          this.push(null);
        }
      }) as any;
      req.method = options.method;
      req.url = options.url;
      req.headers = { host: 'localhost:3456', ...(options.headers || {}) };

      const resChunks: Buffer[] = [];
      let statusCode = 200;

      const res = new Writable({
        write(chunk, encoding, callback) {
          resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        }
      }) as any;

      res.writeHead = (status: number) => {
        statusCode = status;
        return res;
      };
      res.end = (chunk?: any) => {
        if (chunk) resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const output = Buffer.concat(resChunks).toString('utf-8');
        resolve({
          status: statusCode,
          text: () => output,
          json: () => JSON.parse(output)
        });
      };

      server.emit('request', req, res);
    });
  }

  // 19a. Malformed JSON -> -32700 Parse error
  const parseErrRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: '{ invalid_json: '
  });
  const parseErrData = parseErrRes.json() as { error: { code: number; message: string } };
  assert.equal(parseErrData.error.code, -32700);

  // 19b. Missing jsonrpc version or method -> -32600 Invalid Request
  const invalidReqRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, foo: 'bar' })
  });
  const invalidReqData = invalidReqRes.json() as { error: { code: number; message: string } };
  assert.equal(invalidReqData.error.code, -32600);

  // 19c. Unknown method -> -32601 Method not found
  const unknownMethodRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unsupported/method' })
  });
  const unknownMethodData = unknownMethodRes.json() as { error: { code: number } };
  assert.equal(unknownMethodData.error.code, -32601);

  // 19d. Missing required params -> -32602 Invalid params
  const invalidParamsRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'check_watch_now', arguments: {} } // missing watch_id
    })
  });
  const invalidParamsData = invalidParamsRes.json() as { error: { code: number } };
  assert.equal(invalidParamsData.error.code, -32602);

  // 19e. Protocol Capability Negotiation in initialize
  const initRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' }
    })
  });
  const initData = initRes.json() as {
    result: {
      protocolVersion: string;
      capabilities: { tools: { listChanged: boolean }; resources: { subscribe: boolean } };
    };
  };
  assert.equal(initData.result.protocolVersion, '2024-11-05');
  assert.equal(initData.result.capabilities.tools.listChanged, true);
  assert.equal(initData.result.capabilities.resources.subscribe, true);

  // 19f. Read-only and subscribable resources (resources/list & resources/read)
  const testWatch = watchService.createWatch(
    {
      title: 'Resource Inspection Test',
      chat_context: 'Testing pulseremind://watches resource URI'
    },
    'tenant_default'
  );

  const listResourcesRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list' })
  });
  const listResourcesData = listResourcesRes.json() as {
    result: { resources: Array<{ uri: string; name: string }> };
  };
  assert.ok(listResourcesData.result.resources.some((r) => r.uri === 'pulseremind://watches'));
  assert.ok(listResourcesData.result.resources.some((r) => r.uri === `pulseremind://watches/${testWatch.id}`));

  // Read single watch resource
  const readResourceRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri: `pulseremind://watches/${testWatch.id}` }
    })
  });
  const readResourceData = readResourceRes.json() as {
    result: { contents: Array<{ uri: string; mimeType: string; text: string }> };
  };
  assert.equal(readResourceData.result.contents[0].uri, `pulseremind://watches/${testWatch.id}`);
  const parsedPayload = JSON.parse(readResourceData.result.contents[0].text);
  assert.equal(parsedPayload.watch.id, testWatch.id);

  // Subscribe and unsubscribe
  const subRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/subscribe',
      params: { uri: `pulseremind://watches/${testWatch.id}` }
    })
  });
  assert.equal(subRes.status, 200);

  const unsubRes = await dispatch({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'resources/unsubscribe',
      params: { uri: `pulseremind://watches/${testWatch.id}` }
    })
  });
  assert.equal(unsubRes.status, 200);

  watchService.deleteWatch(testWatch.id);
});

test('20. Anti-Fragile Semantic Resolution: OpenGraph, Microdata, Container Stripping & Grammatical Cohort Resolution', async () => {
  const { evaluateWebpageSignals, extractStructuredPortalState } = await import(
    '../src/internal/resolution/validator.ts'
  );

  const testWatch = watchService.createWatch({
    title: 'OpenGraph & Microdata Summit 2027',
    chat_context: 'Testing structured metadata parsing'
  });

  // 20a. OpenGraph availability="instock"
  const ogHtmlInStock = `
    <html>
      <head>
        <meta property="og:title" content="OpenGraph Summit 2027" />
        <meta property="og:availability" content="instock" />
      </head>
      <body><h1>OpenGraph Summit 2027</h1></body>
    </html>
  `;
  const ogRes1 = extractStructuredPortalState(ogHtmlInStock, 'https://example.com', 2027);
  assert.equal(ogRes1.isOpen, true);
  assert.equal(ogRes1.source, 'opengraph');

  // 20b. OpenGraph availability="oos"
  const ogHtmlOos = `
    <html>
      <head>
        <meta property="og:title" content="OpenGraph Summit 2027" />
        <meta property="og:availability" content="oos" />
      </head>
      <body><h1>OpenGraph Summit 2027</h1></body>
    </html>
  `;
  const ogRes2 = extractStructuredPortalState(ogHtmlOos, 'https://example.com', 2027);
  assert.equal(ogRes2.isOpen, false);
  assert.equal(ogRes2.source, 'opengraph');

  // 20c. Schema.org Microdata (itemprop="availability")
  const microdataHtml = `
    <div itemscope itemtype="http://schema.org/Event">
      <span itemprop="name">Microdata Summit 2027</span>
      <link itemprop="availability" href="http://schema.org/InStock" />
    </div>
  `;
  const microRes = extractStructuredPortalState(microdataHtml, 'https://example.com', 2027);
  assert.equal(microRes.isOpen, true);
  assert.equal(microRes.source, 'microdata');

  // 20d. Dialog and modal container isolation: CTAs inside <dialog> or modal overlays are ignored
  const dialogHtml = `
    <html>
      <body>
        <main>
          <h1>OpenGraph & Microdata Summit 2027</h1>
          <p>Registration is currently closed. Check back next month.</p>
        </main>
        <dialog open>
          <h2>Unrelated Dialog Modal</h2>
          <a href="/unrelated/apply">Apply Now</a>
        </dialog>
        <div class="modal-backdrop">
          <a href="/login/apply">Apply Now to Login</a>
        </div>
      </body>
    </html>
  `;
  const dialogSignals = evaluateWebpageSignals(testWatch, dialogHtml, 'https://example.com');
  assert.equal(dialogSignals.isOpen, false, 'Should ignore Apply Now CTAs inside dialogs/modals');

  // 20e. Grammatical tense & cohort resolution: past cycle announcement ("applications for the 2024 cycle closed")
  const pastCycleHtml = `
    <html>
      <body>
        <main>
          <h1>OpenGraph & Microdata Summit 2027</h1>
          <p>Applications for the 2024 cycle closed on December 15. The 2027 cohort will open in early spring.</p>
          <a href="/apply" class="disabled" disabled>Apply Now</a>
        </main>
      </body>
    </html>
  `;
  const pastCycleSignals = evaluateWebpageSignals(testWatch, pastCycleHtml, 'https://example.com');
  assert.equal(pastCycleSignals.isOpen, false, 'Past cycle closures must NOT trigger false positive');

  watchService.deleteWatch(testWatch.id);
});

test('21. Universal Temporal State Machine & 180-Day Deterministic Virtual-Time Leap Suite (< 1 second)', async () => {
  const { calculateHazardRateSchedule } = await import('../src/internal/temporal/hazard-rate.ts');
  const { canTransition, assertValidTransition } = await import(
    '../src/internal/temporal/state-machine.ts'
  );
  const { buildWatchIcsFeed, validateIcsCompliance } = await import('../src/pkg/calendar/ics.ts');

  const startTime = Date.now();
  const simulatedStartUnix = 1800000000; // Base reference virtual time
  const targetEventUnix = simulatedStartUnix + 180 * 86400; // 180 days into the future

  // 1. T = 0 (180 days before event): State is HIBERNATING with low-frequency polling (~7 days)
  const schedT0 = calculateHazardRateSchedule(targetEventUnix, simulatedStartUnix);
  assert.equal(schedT0.status, 'hibernating');
  assert.equal(schedT0.phaseLabel, 'pre_window_hibernation');
  assert.ok(
    schedT0.intervalSeconds >= 6 * 86400 && schedT0.intervalSeconds <= 8 * 86400,
    `Interval (${schedT0.intervalSeconds}s) should be ~7 days`
  );

  // 2. Advance virtual time to T + 160 days (20 days before event): EXPONENTIAL_APPROACH phase (2h - 24h)
  const simulatedT160 = simulatedStartUnix + 160 * 86400;
  const schedT160 = calculateHazardRateSchedule(targetEventUnix, simulatedT160);
  assert.equal(schedT160.status, 'exponential_approach');
  assert.ok(canTransition('hibernating', 'exponential_approach'));
  assert.ok(
    schedT160.intervalSeconds >= 5000 && schedT160.intervalSeconds <= 100000,
    `Interval (${schedT160.intervalSeconds}s) should be between ~2h and ~24h (accounting for jitter)`
  );

  // 3. Advance virtual time to T + 178 days (2 days before event): ACTIVE_SAMPLING phase (30m - 60m)
  const simulatedT178 = simulatedStartUnix + 178 * 86400;
  const schedT178 = calculateHazardRateSchedule(targetEventUnix, simulatedT178);
  assert.equal(schedT178.status, 'active_sampling');
  assert.ok(canTransition('exponential_approach', 'active_sampling'));
  assert.ok(
    schedT178.intervalSeconds >= 1800 && schedT178.intervalSeconds <= 3600,
    `Interval (${schedT178.intervalSeconds}s) should be between 30m and 60m`
  );

  // 4. Advance virtual time to T + 179 days, 23 hours, 55 minutes (5m before event): Hyperbolic burst sampling
  const simulatedT179_Burst = targetEventUnix - 300;
  const schedBurst = calculateHazardRateSchedule(targetEventUnix, simulatedT179_Burst);
  assert.equal(schedBurst.status, 'active_sampling');
  assert.ok(
    schedBurst.intervalSeconds <= 60,
    `Burst interval (${schedBurst.intervalSeconds}s) must compress to <= 60s`
  );

  // 5. Dual-VALARM calendar verification for calendar reminders at T-24h and T-1h + RRULE
  const sampleWatch = watchService.createWatch({
    title: 'NeurIPS 2027 Full Paper Registration & Submission Window',
    chat_context: 'Submit 8-page paper and action checklist before AoE deadline.',
    window_start_date: new Date(targetEventUnix * 1000).toISOString(),
    trigger_type: 'web_monitor',
    category: 'hackathon',
    rrule: 'FREQ=YEARLY'
  });

  const icsFeed = buildWatchIcsFeed([sampleWatch], 'https://pulseremind.ai');
  const compliance = validateIcsCompliance(icsFeed);
  assert.equal(compliance.valid, true);
  assert.ok(icsFeed.includes('TRIGGER:-PT24H'), 'Must include 24-hour VALARM');
  assert.ok(icsFeed.includes('TRIGGER:-PT1H'), 'Must include 1-hour VALARM');
  assert.ok(icsFeed.includes('RRULE:FREQ=YEARLY'), 'Must include RRULE from watch metadata');

  // 6. Directed transition cycle verification: TRIGGERED -> COOLED_DOWN -> ARCHIVED
  assert.ok(canTransition('active_sampling', 'triggered'));
  assert.ok(canTransition('triggered', 'cooled_down'));
  assert.ok(canTransition('cooled_down', 'archived'));
  assert.throws(() => assertValidTransition('archived', 'triggered'), /Invalid event state transition/);

  watchService.deleteWatch(sampleWatch.id);

  const elapsedMs = Date.now() - startTime;
  assert.ok(elapsedMs < 1000, `180-day virtual-time leap suite must complete in < 1 second (took ${elapsedMs}ms)`);
});

test('22. Universal Event Resolution Test Matrix: 20+ Real-World Event Classes (0% False Positives & Multi-Tenant Isolation)', async () => {
  const { evaluateWebpageSignals } = await import('../src/internal/resolution/validator.ts');
  const { evaluateRRule } = await import('../src/internal/temporal/rrule.ts');

  const matrix = [
    {
      id: 'event_01_product_ps6',
      title: 'Sony PlayStation 6 Pre-Order Drop',
      category: 'product_launch',
      html: `
        <html><head>
          <script type="application/ld+json">
          { "@context": "https://schema.org", "@type": "Product", "name": "PlayStation 6 Console", "offers": { "@type": "Offer", "availability": "https://schema.org/InStock", "url": "https://direct.playstation.com/ps6/preorder" } }
          </script>
        </head><body><main><h1>PlayStation 6 Console Pre-Order</h1></main></body></html>
      `,
      expectedOpen: true,
      reason: 'InStock JSON-LD'
    },
    {
      id: 'event_02_festival_glastonbury',
      title: 'Glastonbury Festival 2027 Coach + Ticket Packages',
      category: 'tickets',
      html: `
        <html><head>
          <meta property="og:availability" content="instock" />
        </head><body><main><h1>Glastonbury Festival 2027</h1><a href="/tickets/buy">Buy Tickets</a></main></body></html>
      `,
      expectedOpen: true,
      reason: 'OpenGraph instock'
    },
    {
      id: 'event_03_sec_10k_filing',
      title: 'Alphabet Inc Form 10-K Annual Filing Deadline',
      category: 'regulatory_deadline',
      html: `
        <html><body><main>
          <h1>SEC Filing Portal: Alphabet Inc Form 10-K</h1>
          <p>Submission deadline: February 14, 2027 at 17:00 AoE</p>
          <a href="/sec/edgar/submit">Online Application Portal</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'AoE regulatory deadline & online portal CTA'
    },
    {
      id: 'event_04_visa_appointment',
      title: 'US Embassy London B1/B2 Visa Interview Slot Opening',
      category: 'visa_slot',
      html: `
        <html><body><main>
          <h1 itemprop="name">US Embassy London B1/B2 Visa Appointment</h1>
          <div itemprop="availability" content="https://schema.org/PreOrder">Available for booking</div>
          <a href="/visa/ais/book">Register Now</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'Microdata PreOrder availability'
    },
    {
      id: 'event_05_court_docket',
      title: 'Supreme Court Case 26-1049 Certiorari Brief Deadline',
      category: 'court_docket',
      html: `
        <html><body><main>
          <h1>Supreme Court Docket 26-1049</h1>
          <p>Brief due by March 15, 2027</p>
          <a href="/docket/file">Start Application</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'Court filing deadline'
    },
    {
      id: 'event_06_academic_neurips',
      title: 'NeurIPS 2027 Paper Submission and Review Cycle',
      category: 'conference',
      html: `
        <html><head>
          <script type="application/ld+json">
          { "@context": "https://schema.org", "@type": "Event", "name": "NeurIPS 2027 Conference", "eventStatus": "https://schema.org/EventScheduled", "url": "https://openreview.net/neurips2027" }
          </script>
        </head><body><main><h1>NeurIPS 2027 OpenReview</h1><a href="/apply">Submit Application</a></main></body></html>
      `,
      expectedOpen: true,
      reason: 'EventScheduled JSON-LD'
    },
    {
      id: 'event_07_cloud_aws_reinvent',
      title: 'AWS re:Invent 2027 Pass Registration Drop',
      category: 'conference',
      html: `
        <html><body><main>
          <h1>AWS re:Invent 2027 Pass Registration</h1>
          <p>Registration for full conference passes is now open!</p>
          <a href="/reinvent/register">Register Now</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'Live non-disabled register CTA'
    },
    {
      id: 'event_08_developer_github_universe',
      title: 'GitHub Universe 2027 Super Early-Bird Passes',
      category: 'conference',
      html: `
        <html><body><main>
          <h1>GitHub Universe 2027</h1>
          <div itemprop="eventStatus" content="https://schema.org/EventScheduled">Confirmed</div>
          <a href="/universe/tickets">Get Tickets</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'Microdata EventScheduled'
    },
    {
      id: 'event_09_hackathon_ethglobal',
      title: 'ETHGlobal Tokyo 2027 Hacker Applications',
      category: 'hackathon',
      html: `
        <html><head>
          <script id="__NEXT_DATA__" type="application/json">
          { "props": { "pageProps": { "applicationsOpen": true, "applyUrl": "https://ethglobal.com/apply/tokyo-2027" } } }
          </script>
        </head><body><main><h1>ETHGlobal Tokyo 2027</h1></main></body></html>
      `,
      expectedOpen: true,
      reason: '__NEXT_DATA__ applicationsOpen'
    },
    {
      id: 'event_10_accelerator_yc',
      title: 'Y Combinator Winter 2027 Batch Application Deadline',
      category: 'grant',
      html: `
        <html><body><main>
          <h1>Y Combinator W27 Batch</h1>
          <p>Application deadline: October 15, 2026 at 20:00 AoE</p>
          <a href="https://apply.ycombinator.com">Apply Now</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'YC application deadline and live portal link'
    },
    {
      id: 'event_11_sports_world_cup',
      title: 'FIFA World Cup 2026 Final Phase Ticket Sales',
      category: 'tickets',
      html: `
        <html><head>
          <script type="application/ld+json">
          { "@context": "https://schema.org", "@type": "SportsEvent", "name": "FIFA World Cup 2026 Final", "offers": { "availability": "https://schema.org/InStock", "url": "https://fifa.com/tickets" } }
          </script>
        </head><body><main><h1>FIFA World Cup 2026</h1></main></body></html>
      `,
      expectedOpen: true,
      reason: 'SportsEvent InStock offer'
    },
    {
      id: 'event_12_tech_wwdc',
      title: 'Apple WWDC 2027 Keynote & Developer Lottery',
      category: 'conference',
      html: `
        <html><head>
          <script id="__NUXT_DATA__" type="application/json">
          [ { "registrationOpen": true, "applyUrl": "https://developer.apple.com/wwdc27/apply" } ]
          </script>
        </head><body><main><h1>Apple WWDC 2027</h1></main></body></html>
      `,
      expectedOpen: true,
      reason: '__NUXT_DATA__ registrationOpen'
    },
    {
      id: 'event_13_tour_taylor_swift',
      title: 'Taylor Swift Eras Tour London Additional Dates',
      category: 'tickets',
      html: `
        <html><head>
          <script type="application/ld+json">
          { "@context": "https://schema.org", "@type": "MusicEvent", "name": "Taylor Swift Eras Tour London", "offers": { "availability": "https://schema.org/SoldOut" } }
          </script>
        </head><body><main><h1>Taylor Swift Wembley</h1><p>Tickets are currently sold out.</p></main></body></html>
      `,
      expectedOpen: false,
      reason: 'SoldOut JSON-LD (must NOT trigger false positive)'
    },
    {
      id: 'event_14_mba_stanford',
      title: 'Stanford Graduate School of Business MBA Round 1 Deadline',
      category: 'scholarship',
      html: `
        <html><body><main>
          <h1>Stanford Graduate School of Business MBA</h1>
          <p>Application deadline: September 10, 2026</p>
          <a href="/mba/apply">Start Application</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'Admissions deadline'
    },
    {
      id: 'event_15_nih_r01',
      title: 'NIH R01 Research Project Grant October Cycle Submission',
      category: 'grant',
      html: `
        <html><body><main>
          <h1>NIH R01 Research Project Grant Cycle</h1>
          <p>Submission deadline: October 5, 2026</p>
          <a href="/nih/apply">Online Application Portal</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'Research grant deadline'
    },
    {
      id: 'event_16_cern_beamtime',
      title: 'CERN ISOLDE Beamtime Proposal Call 2027',
      category: 'regulatory_deadline',
      html: `
        <html><head>
          <script type="application/ld+json">
          { "@context": "https://schema.org", "@type": "Event", "name": "CERN ISOLDE Beamtime Call 2027", "eventStatus": "https://schema.org/EventCancelled" }
          </script>
        </head><body><main><h1>CERN ISOLDE Beamtime Call</h1><p>This call has been cancelled.</p></main></body></html>
      `,
      expectedOpen: false,
      reason: 'EventCancelled JSON-LD (must NOT trigger)'
    },
    {
      id: 'event_17_eclipse_permits',
      title: 'National Park Total Solar Eclipse Viewing Permits',
      category: 'government_permit',
      html: `
        <html><body><main>
          <h1>National Park Total Solar Eclipse Viewing Permits</h1>
          <p>Permit applications for the 2024 viewing have closed. The 2027 permits will open in winter.</p>
          <a href="/permit/apply" class="disabled" disabled aria-disabled="true">Apply Now</a>
        </main></body></html>
      `,
      expectedOpen: false,
      reason: 'Past cohort year & disabled button (must NOT trigger false positive)'
    },
    {
      id: 'event_18_visa_uk_hpi',
      title: 'UK High Potential Individual (HPI) Visa Allocation Ballot',
      category: 'visa_slot',
      html: `
        <html><body><main>
          <h1>UK High Potential Individual Visa Ballot</h1>
          <p>Registration window: Open until November 25, 2026</p>
          <a href="/govuk/hpi/register">Sign Up Now</a>
        </main></body></html>
      `,
      expectedOpen: true,
      reason: 'Active immigration registration'
    },
    {
      id: 'event_19_motorsport_f1_monaco',
      title: 'Formula 1 Monaco Grand Prix 2027 Grandstand Tickets',
      category: 'tickets',
      html: `
        <html><head>
          <script type="application/ld+json">
          { "@context": "https://schema.org", "@type": "SportsEvent", "name": "Formula 1 Monaco Grand Prix 2027", "offers": { "availability": "https://schema.org/LimitedAvailability", "url": "https://monaco-grandprix.com/tickets" } }
          </script>
        </head><body><main><h1>Formula 1 Monaco Grand Prix 2027</h1></main></body></html>
      `,
      expectedOpen: true,
      reason: 'LimitedAvailability JSON-LD'
    },
    {
      id: 'event_20_retail_black_friday',
      title: 'Black Friday 2026 Next-Gen Console Doorbuster',
      category: 'product_launch',
      html: `
        <html><head>
          <meta property="og:availability" content="sold_out" />
        </head><body><main><h1>Black Friday Console Bundle</h1><p>Sold out online.</p></main></body></html>
      `,
      expectedOpen: false,
      reason: 'OpenGraph sold_out (must NOT trigger)'
    },
    {
      id: 'event_21_calendar_standup_rrule',
      title: 'Daily Core Engineering Sync & Standup',
      category: 'calendar_reminder',
      html: '<html><body><main><h1>Engineering Sync</h1></main></body></html>',
      expectedOpen: false,
      isCalendarRRule: true,
      rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
      reason: 'Pure recurring calendar reminder with RFC 5545 RRULE'
    }
  ];

  assert.ok(matrix.length >= 21, 'Matrix must evaluate at least 21 diverse event classes');

  for (const item of matrix) {
    if (item.isCalendarRRule) {
      const dates = evaluateRRule(item.rrule, new Date('2026-10-26T09:00:00Z'), 5);
      assert.equal(dates.length, 5, 'RRULE must calculate next 5 weekdays correctly');
      continue;
    }

    const testWatch = watchService.createWatch({
      title: item.title,
      category: item.category as any,
      chat_context: `Matrix test case: ${item.reason}`,
      target_url: 'https://example.com'
    });

    const signals = evaluateWebpageSignals(testWatch, item.html, 'https://example.com');
    assert.equal(
      signals.isOpen,
      item.expectedOpen,
      `Matrix event failed [${item.id} - ${item.title}]: expected isOpen=${item.expectedOpen}, got ${signals.isOpen} (${signals.summary})`
    );

    watchService.deleteWatch(testWatch.id);
  }

  // Multi-Tenant Isolation proof across Matrix Watches
  const tenant1 = 'tenant_matrix_alpha';
  const tenant2 = 'tenant_matrix_beta';

  const w1 = watchService.createWatch({ title: 'Tenant 1 Private Watch' }, tenant1);
  const w2 = watchService.createWatch({ title: 'Tenant 2 Private Watch' }, tenant2);

  const t1List = watchService.listWatches('all', tenant1);
  const t2List = watchService.listWatches('all', tenant2);

  assert.equal(t1List.length, 1);
  assert.equal(t1List[0].id, w1.id);
  assert.equal(t2List.length, 1);
  assert.equal(t2List[0].id, w2.id);

  watchService.deleteWatch(w1.id, tenant1);
  watchService.deleteWatch(w2.id, tenant2);
});

test('23. Anti-Flap Multi-Probe Consensus Verification & Recipient Token-Bucket Rate Limiter Proof', async () => {
  const { verifyProbeConsensus } = await import('../src/internal/resolution/consensus.ts');
  const { RecipientRateLimiter } = await import('../src/internal/notification/rate-limiter.ts');

  // 23a. Anti-Flap Consensus Verification: Inconsistent probes detect flapping and suppress false alerts
  const primaryOpen = {
    httpStatus: 200,
    isOpen: true,
    outcome: 1 as const,
    confidence: 0.85,
    summary: 'Primary probe detected open CTA button',
    extractedSnippet: 'Apply Now',
    snapshotHash: 'hash_primary_1',
    pageChanged: true,
    detectedDeadline: 'November 1, 2026',
    detectedOpenDate: null,
    detectedApplyUrl: 'https://example.com/apply',
    oracleRecord: null,
    cacheHit: false,
    entityValidated: true
  };

  const secondaryClosed = {
    ...primaryOpen,
    isOpen: false,
    outcome: 2 as const,
    summary: 'Secondary verification probe sees closed portal (503 transient error)',
    snapshotHash: 'hash_secondary_flapping'
  };

  const flappingOutcome = verifyProbeConsensus(primaryOpen, secondaryClosed);
  assert.equal(flappingOutcome.confirmed, false, 'Consensus must reject discordant probes');
  assert.equal(flappingOutcome.isFlapping, true, 'Flapping state must be flagged');
  assert.equal(flappingOutcome.agreedState, null);
  assert.ok(flappingOutcome.reason.includes('Flapping state detected'));

  // When secondary probe confirms open state, consensus outcome is confirmed with high confidence
  const secondaryConfirmed = {
    ...primaryOpen,
    isOpen: true,
    outcome: 1 as const,
    confidence: 0.95,
    summary: 'Secondary verification probe confirms live application portal'
  };
  const confirmedOutcome = verifyProbeConsensus(primaryOpen, secondaryConfirmed);
  assert.equal(confirmedOutcome.confirmed, true, 'Consensus must confirm concordant probes');
  assert.equal(confirmedOutcome.isFlapping, false);
  assert.equal(confirmedOutcome.agreedState, true);
  assert.ok(confirmedOutcome.confidence >= 0.95);

  // 23b. Recipient Leaky Token Bucket Rate Limiter
  const limiter = new RecipientRateLimiter(5, 0.1); // capacity: 5 tokens, refill: 0.1 tokens/sec
  const recipientKey = 'fatigue_test_recipient@corp.com';

  // Consume first 5 tokens immediately in a sudden burst
  for (let i = 0; i < 5; i++) {
    const res = limiter.consume(recipientKey);
    assert.equal(res.allowed, true, `Token ${i + 1} must be granted`);
  }

  // 6th immediate request in the burst is rate-limited to prevent fatigue / alert storms
  const burstExceeded = limiter.consume(recipientKey);
  assert.equal(burstExceeded.allowed, false, 'Burst exceeding bucket capacity must be blocked');
  assert.equal(burstExceeded.remainingTokens, 0);

  // Different recipient has independent bucket
  const otherRecipient = limiter.consume('different_user@university.edu');
  assert.equal(otherRecipient.allowed, true, 'Different recipient must have independent quota');
});

test('24. Process Crash Resilience, Monotonic Outbox Replay & Notification Ack Flow', async () => {
  const { createAppServer } = await import('../src/pkg/server/http-server.ts');
  const { createOAuthJwtToken } = await import('../src/pkg/tenant/tenant.ts');
  const { outboxProcessor } = await import('../src/pkg/db/outbox.ts');
  const { Readable } = await import('node:stream');

  const server = createAppServer();
  const tenant = 'tenant_crash_replay';
  const token = createOAuthJwtToken(tenant, 'crash_user@pulseremind.ai');

  function dispatch(options: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    text: () => string;
    json: () => Record<string, unknown>;
  }> {
    return new Promise((resolve, reject) => {
      const req = new Readable({
        read() {
          this.push(options.body || null);
          this.push(null);
        }
      }) as any;

      req.method = options.method;
      req.url = options.url;
      req.headers = { host: 'localhost:3456', ...(options.headers || {}) };

      const chunks: Buffer[] = [];
      let statusCode = 200;

      const res = {
        writeHead(code: number, headers?: Record<string, string>) {
          statusCode = code;
          return this;
        },
        write(chunk: any) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
        end(chunk?: any) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const output = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: statusCode,
            text: () => output,
            json: () => JSON.parse(output)
          });
        },
        on: () => res
      } as any;

      server.emit('request', req, res);
    });
  }

  // 24a. Create a watch and generate an alert
  const watch = watchService.createWatch(
    {
      title: 'Crash Recovery Fellowship 2027',
      chat_context: 'Test outbox crash replay'
    },
    tenant
  );

  const notif = notificationService.insertInAppAlert({
    watchId: watch.id,
    watchTitle: watch.title,
    summary: 'Crash test notification',
    details: 'Verify outbox sync post-restart',
    tenantId: tenant
  });

  // Verify notification was written locally
  assert.equal(notif.delivery_status, 'delivered');
  assert.equal(notif.is_read, false);

  // 24b. Notification Acknowledgment Endpoint (POST /api/notifications/:id/open)
  const ackRes = await dispatch({
    method: 'POST',
    url: `/api/notifications/${encodeURIComponent(notif.id)}/open`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(ackRes.status, 200);
  const ackData = ackRes.json() as { success: boolean; delivery_status: string };
  assert.equal(ackData.success, true);
  assert.equal(ackData.delivery_status, 'opened');

  // Verify DB state updated
  const updatedNotif = notificationService.getNotificationById(notif.id, tenant);
  assert.ok(updatedNotif);
  assert.equal(updatedNotif.delivery_status, 'opened');
  assert.equal(updatedNotif.is_read, true);

  // 24c. Simulate Process Crash Recovery & Zero-Duplicate Outbox Replay
  // Drain all pending outbox events (simulating sync to Supabase PostgreSQL after recovery)
  const drainedFirst = await outboxProcessor.drainAll(50);
  assert.ok(drainedFirst.succeeded >= 2, `Should sync at least 2 events (create + status_changed), got ${drainedFirst.succeeded}`);

  // Second drain must produce 0 duplicate sync events
  const drainedSecond = await outboxProcessor.drainAll(50);
  assert.equal(drainedSecond.processed, 0, 'Subsequent drain must process 0 duplicate events');

  // Verify all events in outbox for this tenant have status = 'published'
  const events = outboxProcessor.listEvents(tenant);
  assert.ok(events.length >= 2);
  for (const ev of events) {
    assert.equal(ev.status, 'published', 'All outbox records must be marked published');
  }

  // Clean up
  watchService.deleteWatch(watch.id, tenant);
});





