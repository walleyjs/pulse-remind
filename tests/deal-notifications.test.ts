import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { emailProvider } from '../src/internal/notification/providers/email.provider.ts';
import { createAppServer } from '../src/pkg/server/http-server.ts';
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
    extractedSnippet: 'Scanfrost 4-Burner Gas Cooker Current Price: ₦130,500 (List: ₦180,000) { "@context": "https://schema.org", "@type": "Product" }',
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
        promoCodeVerified: 'CHEF10',
        detectedPromoDiscount: '10% off',
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

test('1. Zero-Leakage Email Linter: 0% Raw JSON-LD Boilerplate and 0% USD Markers for NGN Watch', () => {
  const watch = createMockCommerceWatch();
  const evaluation = createMockCommerceEvaluation();

  const html = emailProvider.buildOpportunityOpenHtml(watch, evaluation);

  // Assert ZERO raw JSON-LD markers
  assert.equal(html.includes('@context'), false, 'Email HTML must not leak "@context"');
  assert.equal(html.includes('@type'), false, 'Email HTML must not leak "@type"');
  assert.equal(html.includes('https://schema.org'), false, 'Email HTML must not leak Schema.org URL');

  // Assert ZERO USD markers for an NGN watch
  assert.equal(html.includes('USD'), false, 'Email HTML must not render USD on an NGN watch');
  assert.equal(html.includes('USD 1499.00'), false, 'Email HTML must not render fallback USD 1499.00');
  assert.equal(html.includes('$'), false, 'Email HTML must not render dollar signs on an NGN watch');

  // Assert correct NGN currency and pricing
  assert.ok(html.includes('₦130,500'), 'Email HTML must render current price in ₦ NGN');
  assert.ok(html.includes('₦125,000'), 'Email HTML must render target price in ₦ NGN');
  assert.ok(html.includes('₦49,500'), 'Email HTML must render calculated savings in ₦ NGN');
});

test('2. Commerce Email Template Assertions: E-Commerce Layout vs Scholarship Suppression', () => {
  const watch = createMockCommerceWatch();
  const evaluation = createMockCommerceEvaluation();

  const html = emailProvider.buildOpportunityOpenHtml(watch, evaluation);

  // Assert Commerce-specific sections are present
  assert.ok(html.includes('Price Alert • Target Reached'), 'Must display Commerce price drop banner');
  assert.ok(html.includes('Jumia Official Store'), 'Must render verified store name');
  assert.ok(html.includes('In Stock (Verified)'), 'Must render verified in-stock pill');
  assert.ok(html.includes('CHEF10'), 'Must render verified promo code');
  assert.ok(html.includes('Buy on Official Store'), 'Must include primary official store button');
  assert.ok(html.includes('Chat with Alaba Stall on WhatsApp'), 'Must include secondary WhatsApp button');

  // Assert Scholarship/fellowship semantics are strictly suppressed
  assert.equal(html.includes('OPEN / LIVE'), false, 'Must suppress scholarship "OPEN / LIVE" badge');
  assert.equal(html.includes('Detected Deadline'), false, 'Must suppress scholarship "Detected Deadline"');
  assert.equal(html.includes('accepting applications'), false, 'Must suppress "accepting applications" wording');
});

test('3. Mobile Deal Gateway Wire Probe: Responsive CSS, Dynamic NGN Hydration, and Action Buttons', async () => {
  const server = createAppServer({ port: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const localBaseUrl = `http://localhost:${address.port}`;

  try {
    // Probe 1: Implicit Nigerian context query
    const res1 = await fetch(
      `${localBaseUrl}/demo/deal-portal?store=Jumia+Official+Store&title=Scanfrost+4-Burner+Gas+Cooker`
    );
    assert.equal(res1.status, 200);
    const body1 = await res1.text();

    // Responsive viewport meta tag
    assert.ok(body1.includes('meta name="viewport" content="width=device-width, initial-scale=1.0"'));

    // Dynamic currency inference (NGN for cooker & Jumia)
    assert.ok(body1.includes('₦130,500'), 'Must infer ₦130,500 NGN price');
    assert.equal(body1.includes('USD 1499.00'), false, 'Must not default to USD 1499.00');

    // Interactive promo code component & copy button
    assert.ok(body1.includes('code>CHEF10</code>'), 'Must display copyable promo code CHEF10');
    assert.ok(body1.includes('Copy Code'), 'Must render Copy Code button');

    // Dual action buttons
    assert.ok(body1.includes('Proceed to Official Checkout'), 'Must render Official Checkout button');
    assert.ok(body1.includes('Chat with Alaba Stall on WhatsApp'), 'Must render WhatsApp negotiation button');

    // Valid JSON-LD with NGN
    assert.ok(body1.includes('"priceCurrency": "NGN"'), 'JSON-LD must specify NGN currency');
    assert.ok(body1.includes('"price": "130500.00"'), 'JSON-LD must specify 130500.00 price');

    // Probe 2: Explicit USD query for Apple laptop
    const res2 = await fetch(
      `${localBaseUrl}/demo/deal-portal?currency=USD&price=1499.00&list_price=1999.00&title=Apple+MacBook+Pro+M4`
    );
    assert.equal(res2.status, 200);
    const body2 = await res2.text();
    assert.ok(body2.includes('$1,499'), 'Must respect explicit USD parameters');
    assert.ok(body2.includes('"priceCurrency": "USD"'));
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

test('4. Live Cloud Round-Trip Probe: Deployed Render Instance Serves Responsive Gateway', async () => {
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
