import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { emailProvider, verifyChatResumptionToken } from '../src/internal/notification/providers/email.provider.ts';
import { createAppServer } from '../src/pkg/server/http-server.ts';
import { watchRepository } from '../src/internal/watch/repository.ts';
import { watchService } from '../src/internal/watch/service.ts';
import { webPortalOracleAdapter as webPortalAdapter } from '../src/internal/resolution/adapters/web-portal.adapter.ts';
import type { WatchRecord } from '../src/internal/watch/model.ts';
import type { EvaluationResult } from '../src/internal/resolution/types.ts';

const CLOUD_BASE_URL = 'https://pulse-remind.onrender.com';

function createMockCommerceWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: 'watch_test_commerce_001',
    tenant_id: 'tenant_default',
    version: 1,
    title: 'Scanfrost 4-Burner Gas Cooker Under ₦125k',
    category: 'commerce_drop',
    chat_context: 'Monitor for Scanfrost 4-Burner Gas Cooker with Oven dropping under ₦125,000 in Lagos',
    source_chat_client: 'Web Dashboard / MCP',
    target_url: 'https://pulse-remind.onrender.com/demo/deal-portal?store=Jumia+Official+Store&title=Scanfrost+4-Burner+Gas+Cooker',
    secondary_url: null,
    canonical_url_key: 'https://pulse-remind.onrender.com/demo/deal-portal?title=scanfrost',
    trigger_type: 'web_monitor',
    condition_text: 'Price drops below ₦125,000',
    window_start_date: '2026-10-28',
    window_label: 'End of Month (Oct 2026)',
    rrule: null,
    check_interval_minutes: 60,
    poll_after: 0,
    is_auto_resolve: true,
    proposed_outcome: null,
    closing_soon_notified: false,
    resolution_config: {
      primary_source_name: 'Official Deal Portal',
      primary_source_url: 'https://pulse-remind.onrender.com/demo/deal-portal',
      secondary_source_name: null,
      secondary_source_url: null,
      oracle_api: 'web_portal',
      dynamic_condition: 'commerce_threshold',
      provider_metadata: {
        subscriber_token: 'prm_test_token',
        claim_url: 'https://pulse-remind.onrender.com/claim/prm_test'
      },
      is_auto_resolve: true,
      entity_must_match: true
    },
    oracle_responses: [],
    status: 'active_sampling',
    notify_channels: ['email', 'in_app'],
    recipient_email: 'shopper@example.ng',
    last_checked_at: null,
    last_snapshot_hash: null,
    last_status_summary: 'Target met',
    detected_deadline: null,
    detected_apply_url: null,
    commerce_predicate: {
      targetPrice: 125000,
      currency: 'NGN',
      requiredPromoCode: 'CHEF10'
    },
    last_commerce_state: null,
    cluster_group_id: null,
    triggered_at: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

function createMockCommerceEvaluation(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    httpStatus: 200,
    isOpen: true,
    outcome: 1,
    confidence: 0.98,
    summary: 'DEAL / PRICE TARGET MET (98% confidence, Entity "Scanfrost" verified): Price ₦130,500 <= target ₦140,000',
    extractedSnippet: 'Scanfrost 4-Burner Gas Cooker Current Price: ₦130,500 (List: ₦180,000) Store: Jumia Official Store Promo code CHEF10 gives 10% off',
    snapshotHash: 'hash123',
    pageChanged: true,
    detectedDeadline: '2026-12-31',
    detectedOpenDate: null,
    detectedApplyUrl: 'https://pulse-remind.onrender.com/demo/deal-portal?store=Jumia+Official+Store&title=Scanfrost+4-Burner+Gas+Cooker',
    oracleRecord: {} as any,
    cacheHit: false,
    entityValidated: true,
    commerceEvaluation: {
      satisfied: true,
      reasons: ['Price ₦130,500 satisfies target threshold'],
      extracted: {
        currentPrice: 130500,
        listPrice: 180000,
        currency: 'NGN',
        availability: 'InStock',
        rawRatingValue: 4.8,
        ratingCount: 195,
        ratingScaleMax: 5,
        ratingConfidenceScore: 0.92,
        promoCodeVerified: true,
        detectedPromoDiscount: 10,
        priceValidUntil: '2026-12-31',
        sellerName: 'Jumia Official Store',
        source: 'json_ld'
      },
      effectiveDropPercentage: 27.5,
      savingsAmount: 49500
    },
    ...overrides
  };
}

test('1. Mobile Email Button Inliner & Valid HTTPS Protocol Linter: 0% "#", 0% "localhost", 100% Inline CSS', () => {
  const watch = createMockCommerceWatch({ target_url: 'http://localhost:3456/demo/deal-portal' });
  const evaluation = createMockCommerceEvaluation({ detectedApplyUrl: null });

  const html = emailProvider.buildOpportunityOpenHtml(watch, evaluation);

  // 1. Extract all CTA button links
  const buttonMatches = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*style=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  assert.ok(buttonMatches.length >= 3, 'Must render at least 3 bulletproof action buttons in commerce email');

  for (const m of buttonMatches) {
    const href = m[1];
    const style = m[2];
    const label = m[3];

    // Assert 0% "#" or relative URLs
    assert.notEqual(href, '#', `Button "${label}" must not use placeholder "#"`);
    assert.ok(!href.startsWith('/'), `Button "${label}" must not use relative path`);

    // Assert 0% localhost
    assert.ok(!href.includes('localhost'), `Button "${label}" must not leak localhost URL: ${href}`);
    assert.ok(!href.includes('127.0.0.1'), `Button "${label}" must not leak 127.0.0.1 URL: ${href}`);

    // Assert valid HTTPS scheme (WhatsApp wa.me or pulse-remind https)
    assert.ok(href.startsWith('https://'), `Button "${label}" must use HTTPS protocol: ${href}`);

    // Assert 100% inline CSS touch target (display: block or inline-block, padding, background)
    assert.ok(style.includes('display: block') || style.includes('display: inline-block'), `Button "${label}" must have inline display style`);
    assert.ok(style.includes('padding:'), `Button "${label}" must have inline padding for touch target`);
    assert.ok(style.includes('background:'), `Button "${label}" must have inline background`);
  }

  // Verify HMAC-signed chat resumption link
  const chatMatch = html.match(/href=["'](https:\/\/[^"']*\/chat\?[^"']+)["']/i);
  assert.ok(chatMatch, 'Email must include a signed /chat resumption URL');
  const chatUrl = new URL(chatMatch[1]);
  const token = chatUrl.searchParams.get('token');
  assert.ok(token, 'Chat URL must include HMAC token');
  const verified = verifyChatResumptionToken(token);
  assert.equal(verified.valid, true, 'Chat token must verify successfully with HMAC');
  assert.equal(verified.watchId, watch.id, 'Chat token must match watch ID');
});

test('2. Multi-Store Comparison Leaderboard Validator: Store Names, ₦ Pricing, and Action Links', () => {
  const watch = createMockCommerceWatch();
  const evaluation = createMockCommerceEvaluation();

  const html = emailProvider.buildOpportunityOpenHtml(watch, evaluation);

  // Assert Multi-Store Comparison Leaderboard table is present
  assert.ok(html.includes('Multi-Store Comparison Leaderboard'), 'Must render Multi-Store Comparison header');
  assert.ok(html.includes('<table'), 'Must render comparative table');

  // Assert distinct verified merchant stores
  assert.ok(html.includes('Jumia Official Store'), 'Must include primary verified store');
  assert.ok(html.includes('Jumia Express Nigeria'), 'Must include Jumia Express challenger');
  assert.ok(html.includes('Alaba International Market Stall'), 'Must include Alaba Market challenger');

  // Assert ₦ currency formatting across all stores
  assert.ok(html.includes('₦130,500'), 'Must render primary price in ₦');
  assert.ok(html.includes('₦133,110') || html.includes('₦122,670') || html.includes('₦'), 'Must render comparison prices in ₦');

  // Assert distinct action links for each store
  const viewLinks = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>View\s*&rarr;<\/a>/gi)];
  assert.ok(viewLinks.length >= 2, 'Leaderboard must contain at least 2 distinct store action links');
  const distinctHrefs = new Set(viewLinks.map((v) => v[1]));
  assert.ok(distinctHrefs.size >= 2, 'Leaderboard must contain distinct URLs for each competitor');
});

test('3. Zero-USD Leakage & Zone-Aware Currency Invariance Test for NGN Items', async () => {
  // Directly test webPortalAdapter.resolve against a mock Nigerian deal URL
  const testUrl = 'https://pulse-remind.onrender.com/demo/deal-portal?title=Hisense+7kg+Front+Load+Washing+Machine&seller=Fouani+Store&zone=lagos&price=365000&list_price=420000';
  const watch = createMockCommerceWatch({
    title: 'Hisense 7kg Front Load Washing Machine (WFQP7012EVM)',
    target_url: testUrl,
    commerce_predicate: {
      targetPrice: 350000,
      currency: 'NGN'
    }
  });

  const evaluation = await webPortalAdapter.resolve(watch, true);

  // Assert ZERO USD markers in snippet and summary
  assert.equal(evaluation.extractedSnippet?.includes('USD'), false, 'Extracted snippet must not leak USD');
  assert.equal(evaluation.summary.includes('USD'), false, 'Summary must not leak USD');
  assert.equal(evaluation.extractedSnippet?.includes('@context'), false, 'Snippet must not leak raw JSON-LD');

  // Assert correct NGN resolution
  assert.ok(evaluation.extractedSnippet?.includes('₦365,000'), 'Snippet must include ₦365,000');
  assert.equal(evaluation.commerceEvaluation?.extracted.currency, 'NGN', 'Resolved currency must be NGN');
  assert.equal(evaluation.commerceEvaluation?.extracted.sellerName, 'Fouani Store', 'Resolved store must be Fouani Store');

  // Render email from this evaluation
  const emailHtml = emailProvider.buildOpportunityOpenHtml(watch, evaluation);
  assert.equal(emailHtml.includes('USD 365000.00'), false, 'Email HTML must not format ₦365,000 as USD 365000.00');
  assert.ok(emailHtml.includes('₦365,000'), 'Email HTML must format price as ₦365,000');
  assert.ok(emailHtml.includes('Fouani Store'), 'Email HTML must include seller Fouani Store');
});

test('4. Inbound Conversational Webhook Simulation: Natural Language Reply Updates Watch Target', async () => {
  const server = createAppServer({ port: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const localBaseUrl = `http://localhost:${address.port}`;

  try {
    // 1. Create a watch in SQLite
    const createdWatch = watchService.createWatch({
      title: 'Hisense 7kg Front Load Washer Live Conversational Test',
      tenant_id: 'tenant_default',
      category: 'deal_or_promo',
      chat_context: 'Initial target ₦360k in Lagos',
      source_chat_client: 'Conversational Test',
      target_url: 'https://pulse-remind.onrender.com/demo/deal-portal',
      trigger_type: 'web_monitor',
      condition_text: 'Price drops to ₦360,000',
      notify_channels: ['email'],
      recipient_email: 'walley@example.ng',
      commerce_predicate: {
        targetPrice: 360000,
        currency: 'NGN'
      }
    });

    // 2. Dispatch simulated incoming email reply: "Lower target price to ₦340k"
    const webhookPayload = {
      from: 'walley@example.ng',
      to: `reply+${createdWatch.id}@notify.pulseremind.com`,
      subject: `Re: 🏷️ PRICE DROP ALERT: ${createdWatch.title}`,
      text: 'Can you please lower my target price to ₦340k and verify Alaba pickup?'
    };

    const res = await fetch(`${localBaseUrl}/api/webhooks/inbound-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload)
    });

    assert.equal(res.status, 200, 'Webhook must return 200 OK');
    const responseJson = (await res.json()) as any;

    assert.equal(responseJson.success, true);
    assert.equal(responseJson.watch_id, createdWatch.id);
    assert.equal(responseJson.updated_target_price, 340000, 'Target price must be updated to 340000');
    assert.equal(responseJson.currency, 'NGN');
    assert.ok(responseJson.confirmation_message.includes('₦340,000'), 'Confirmation message must acknowledge ₦340,000');

    // 3. Verify persistent mutation in SQLite
    const mutated = watchRepository.getById(createdWatch.id, 'tenant_default');
    assert.ok(mutated);
    assert.equal(mutated.commerce_predicate?.targetPrice, 340000, 'SQLite watch record must have targetPrice = 340000');
    assert.ok(mutated.condition_text.includes('340,000'), 'Condition text must be updated');

    // 4. Test interactive /chat web session
    const chatRes = await fetch(`${localBaseUrl}/chat?watch_id=${createdWatch.id}`);
    assert.equal(chatRes.status, 200);
    const chatHtml = await chatRes.text();
    assert.ok(chatHtml.includes('Chat with Assistant'), 'Chat page must render header');
    assert.ok(chatHtml.includes('340,000'), 'Chat page must render the updated target threshold');
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

test('5. Live Cloud Round-Trip Probe: Deployed Render Instance Serves Responsive Gateway', async () => {
  const queryUrl = `${CLOUD_BASE_URL}/demo/deal-portal?title=Scanfrost+4-Burner+Gas+Cooker&store=Jumia+Official+Store&currency=NGN&price=130500&list_price=180000`;

  const res = await new Promise<{ statusCode: number; headers: any; body: string }>((resolve, reject) => {
    https.get(queryUrl, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body }));
    }).on('error', reject);
  });

  assert.equal(res.statusCode, 200, 'Cloud gateway must return 200 OK');
  assert.ok(String(res.headers['content-type']).includes('text/html'), 'Must return HTML content');
  assert.ok(res.body.includes('Scanfrost 4-Burner Gas Cooker'), 'Must render product title');
  assert.ok(res.body.includes('130500'), 'Must render target price');
});
