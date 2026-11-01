import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { createAppServer } from '../src/pkg/server/http-server.ts';
import { emailProvider } from '../src/internal/notification/providers/email.provider.ts';
import { dealDiscoveryService } from '../src/internal/discovery/service.ts';
import type { WatchRecord } from '../src/internal/watch/model.ts';
import type { EvaluationResult } from '../src/internal/resolution/types.ts';

const CLOUD_BASE_URL = 'https://pulse-remind.onrender.com';

function createMockWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: 'watch_test_uiux_001',
    tenant_id: 'tenant_default',
    version: 1,
    title: 'Hisense 7kg Front Load Washing Machine (WFQP7012EVM)',
    category: 'commerce_drop',
    chat_context: 'Compare Fouani current landed price against ₦350,000 threshold\nVerify seller trust: Verified merchant (4.9★ across 340+ reviews) • Pay-on-Delivery (POD) eligible',
    source_chat_client: 'Conversational Commerce Gateway',
    target_url: 'https://pulse-remind.onrender.com/demo/deal-portal?seller=Fouani+Official+Store&title=Hisense+7kg+Front+Load+Washing+Machine&price=365000',
    secondary_url: null,
    canonical_url_key: 'https://pulse-remind.onrender.com/demo/deal-portal?title=hisense',
    trigger_type: 'web_monitor',
    condition_text: 'Landed price drops to ₦350,000 with verified merchant status (>= 4.5★)',
    window_start_date: '2026-10-31',
    window_label: 'Immediate Dispatch',
    rrule: null,
    check_interval_minutes: 60,
    poll_after: 0,
    is_auto_resolve: true,
    proposed_outcome: null,
    closing_soon_notified: false,
    resolution_config: {
      primary_source_name: 'Fouani Official Store',
      primary_source_url: 'https://pulse-remind.onrender.com/demo/deal-portal',
      secondary_source_name: null,
      secondary_source_url: null,
      oracle_api: 'web_portal',
      dynamic_condition: 'commerce_threshold',
      provider_metadata: {},
      is_auto_resolve: true,
      entity_must_match: true
    },
    oracle_responses: [],
    status: 'active_sampling',
    notify_channels: ['email', 'in_app'],
    recipient_email: 'customer@example.ng',
    last_checked_at: null,
    last_snapshot_hash: null,
    last_status_summary: 'Target met',
    detected_deadline: null,
    detected_apply_url: null,
    commerce_predicate: {
      targetPrice: 350000,
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

function createMockEvaluation(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    httpStatus: 200,
    isOpen: true,
    outcome: 1,
    confidence: 0.98,
    summary: 'DEAL / PRICE TARGET MET (98% match): Price ₦365,000 <= ₦370,000',
    extractedSnippet: 'Hisense 7kg Front Load Washing Machine Current Price: ₦365,000 (List: ₦420,000) Rating: 4.9 stars (340 reviews) Promo: CHEF10 gives 10% off',
    detectedApplyUrl: 'https://pulse-remind.onrender.com/demo/deal-portal?title=Hisense+7kg+Front+Load+Washing+Machine&seller=Fouani+Official+Store&price=365000&currency=NGN',
    detectedDeadline: '2026-12-31',
    commerceEvaluation: {
      isTargetMet: true,
      extracted: {
        currentPrice: 365000,
        listPrice: 420000,
        currency: 'NGN',
        priceDropAbsolute: 55000,
        priceDropPercentage: 13,
        promoCodeVerified: 'CHEF10',
        ratingConfidenceScore: 0.98,
        rawRatingValue: 4.9,
        ratingCount: 340,
        sellerName: 'Fouani Official Store'
      },
      explanation: 'Verified deal: Price ₦365,000 drops below list price ₦420,000'
    },
    ...overrides
  };
}

test('1. Fitts\'s Law & Touch-Target Compliance: Sticky Thumb-Zone Action Bar with >= 48px Target Height', async () => {
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const localBaseUrl = `http://localhost:${port}`;

  try {
    const res = await fetch(`${localBaseUrl}/demo/deal-portal?title=Hisense+7kg+Washing+Machine&price=365000&currency=NGN`);
    assert.equal(res.status, 200);
    const html = await res.text();

    // 1. Sticky Thumb-Zone action bar validation
    assert.ok(html.includes('sticky-action-bar'), 'Deal Portal must include sticky-action-bar container');
    assert.ok(
      /position:\s*(?:fixed|sticky);[\s\S]*?bottom:\s*0/i.test(html),
      'Action bar must be anchored to the bottom thumb zone'
    );

    // 2. Touch targets must comply with Fitts\'s Law (height >= 48px or min-height >= 48px)
    assert.ok(html.includes('min-height: 48px') && html.includes('height: 48px'), 'Primary CTA touch targets must have at least 48px height');
    assert.ok(html.includes('btn-primary-official'), 'Must include primary official buy button');
    assert.ok(html.includes('btn-primary-whatsapp'), 'Must include primary WhatsApp merchant negotiation button');

    // 3. Verify prices rendered inside primary buttons
    assert.ok(html.includes('Buy Official ₦365,000'), 'Official button must display formatted price');
    assert.ok(html.includes('Chat Stall ₦335,800') || html.includes('Chat Stall ₦'), 'WhatsApp button must display stall discount price');
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

test('2. Consumer Trust Linter: 0% Algorithmic Jargon (Wilson Score) & 100% Tangible Market Stall Footprint', async () => {
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const localBaseUrl = `http://localhost:${port}`;

  try {
    // A. Check Deal Portal
    const portalRes = await fetch(`${localBaseUrl}/demo/deal-portal?title=Scanfrost+Cooker&price=130500&currency=NGN`);
    const portalHtml = await portalRes.text();

    assert.doesNotMatch(portalHtml, /Wilson\s*(?:confidence|score)/i, 'Consumer portal must have 0% Wilson score jargon');
    assert.ok(portalHtml.includes('Shop B12, Electrical Section, Alaba Int\'l Market'), 'Must feature physical market stall address');
    assert.ok(portalHtml.includes('Pay on Delivery (POD) Verified'), 'Must feature Pay on Delivery (POD) trust badge');
    assert.ok(portalHtml.includes('Warranty'), 'Must feature warranty badge');

    // B. Check Generative UI Widget
    const widgetRes = await fetch(`${localBaseUrl}/demo/generative-deal-widget`);
    assert.equal(widgetRes.status, 200);
    const widgetHtml = await widgetRes.text();

    assert.doesNotMatch(widgetHtml, /Wilson\s*(?:confidence|score)/i, 'Generative deal widget must have 0% Wilson score jargon');
    assert.ok(widgetHtml.includes('Shop B12, Alaba Int\'l'), 'Generative deal widget must feature physical stall address');
    assert.ok(widgetHtml.includes('Pay on Delivery (POD)'), 'Generative deal widget must feature POD badge');

    // C. Check Notification Email Output
    const watch = createMockWatch();
    const evaluation = createMockEvaluation();
    const emailHtml = emailProvider.buildOpportunityOpenHtml(watch, evaluation);

    assert.doesNotMatch(emailHtml, /Wilson\s*(?:confidence|score)/i, 'Email notification must purge any Wilson score algorithmic jargon');
    assert.ok(emailHtml.includes('Pay on Delivery (POD)'), 'Email leaderboard/terms must highlight Pay on Delivery');
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

test('3. Responsive Viewport & Zero-Overflow Linter at 375px Mobile Screen Dimensions', async () => {
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const localBaseUrl = `http://localhost:${port}`;

  try {
    const res = await fetch(`${localBaseUrl}/demo/deal-portal?title=Hisense+7kg+Washing+Machine&price=365000&currency=NGN`);
    const html = await res.text();

    // 1. Viewport Meta Tag requirement
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0"'), 'Must specify responsive viewport meta tag');

    // 2. Global Box-Sizing & Zero-Overflow guard
    assert.ok(html.includes('* { box-sizing: border-box; }'), 'Must enforce border-box on all elements to prevent padding overflow');
    assert.ok(html.includes('overflow-x: hidden'), 'Body or container must prevent horizontal overflow on 375px screens');

    // 3. Max-width responsive container
    assert.ok(html.includes('max-width: 640px') && html.includes('margin: 0 auto'), 'Main container must be responsive and centered');
    assert.ok(!html.includes('width: 800px') && !html.includes('width: 1000px'), 'Must not contain rigid fixed desktop widths');
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

test('4. Interactive Quick-Action & 1-Tap Chip Verification: Pre-Composed RFC 3986 WhatsApp Deep Links', async () => {
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const localBaseUrl = `http://localhost:${port}`;

  try {
    const res = await fetch(`${localBaseUrl}/demo/deal-portal?title=Hisense+7kg+Washing+Machine&price=365000&currency=NGN`);
    const html = await res.text();

    // 1. Negotiation Chips Verification
    assert.ok(html.includes('1-Tap Quick Negotiation Pills'), 'Must include 1-tap quick negotiation section');
    assert.ok(html.includes('applyNegotiation(\'offer\''), 'Must include quick offer pill');
    assert.ok(html.includes('applyNegotiation(\'waybill\''), 'Must include Lagos waybill negotiation pill');
    assert.ok(html.includes('applyNegotiation(\'video\''), 'Must include live video proof request pill');

    // 2. RFC 3986 WhatsApp click-to-chat links
    assert.ok(html.includes('https://wa.me/2348023456789?text='), 'Must generate pre-filled RFC 3986 WhatsApp click-to-chat link');
    assert.ok(html.includes('Ref: OJA_INIT') || html.includes('HMAC_'), 'Must generate tamper-evident quote token');

    // 3. Floating Collapsible AI Assistant Drawer
    assert.ok(html.includes('assistant-drawer') && html.includes('chat-drawer-btn'), 'Must include floating collapsible AI Assistant drawer');
    assert.ok(html.includes('/api/webhooks/inbound-email'), 'Drawer form must submit asynchronously to conversational webhook');
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

test('5. Live Cloud Probe to PulseRemind on Render: Deployed Responsive Gateway Integrity', async () => {
  const queryUrl = `${CLOUD_BASE_URL}/demo/deal-portal?title=Hisense+7kg+Front+Load+Washing+Machine&store=Fouani+Official+Store&currency=NGN&price=365000&list_price=420000`;

  const res = await new Promise<{ statusCode: number; headers: any; body: string }>((resolve, reject) => {
    https.get(queryUrl, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body }));
    }).on('error', reject);
  });

  assert.equal(res.statusCode, 200, 'Cloud gateway must respond with 200 OK');
  assert.ok(String(res.headers['content-type']).includes('text/html'), 'Must return HTML content');
  assert.ok(res.body.includes('Hisense 7kg Front Load Washing Machine'), 'Cloud must render product title');
  assert.ok(res.body.includes('365000') || res.body.includes('365,000'), 'Cloud must render formatted or raw price');
  assert.ok(res.body.includes('Fouani Official Store') || res.body.includes('Verified Direct Portal'), 'Cloud must render store badge');
});
