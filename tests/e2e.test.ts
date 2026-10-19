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




