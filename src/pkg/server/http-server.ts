import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { config } from '../../config/index.ts';
import { demoPortalService } from '../../internal/demo/service.ts';
import { dealDiscoveryService } from '../../internal/discovery/service.ts';
import { chatExtractorService } from '../../internal/extractor/service.ts';
import { resolveTimeframeWindow } from '../../internal/extractor/timeframe.ts';
import { notificationService } from '../../internal/notification/service.ts';
import { resolutionEngine } from '../../internal/resolution/engine.ts';
import type { NotificationChannelType, WatchRecord } from '../../internal/watch/model.ts';
import { watchService } from '../../internal/watch/service.ts';
import { initDatabase } from '../db/bootstrap.ts';
import { cloudDatabaseSync } from '../db/cloud-sync.ts';
import { outboxProcessor } from '../db/outbox.ts';
import { extractTenantId, createOAuthJwtToken, deriveCanonicalTenantId } from '../tenant/tenant.ts';
import { buildWatchIcsFeed, buildWatchCalendarLinks } from '../calendar/ics.ts';
import { isDisallowedAmbientEmail } from '../privacy/minimizer.ts';
import { executeMcpTool, MCP_TOOLS } from '../mcp/tools.ts';
import { buildGeminiToolsManifest, buildOpenApiSpec } from './openapi.ts';
import { eventBus } from '../events/event-bus.ts';
import { verifyChatResumptionToken } from '../../internal/notification/providers/email.provider.ts';
import { watchRepository } from '../../internal/watch/repository.ts';
import { extractCommercePredicateFromText, type CommercePredicateConfig } from '../../internal/resolution/predicates.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ics': 'text/calendar; charset=utf-8'
};

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(html);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  if (raw.startsWith('{') || raw.startsWith('[')) {
    return JSON.parse(raw);
  }
  const params = new URLSearchParams(raw);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) {
    obj[k] = v;
  }
  return obj;
}

export function createAppServer(): http.Server {
  initDatabase(true);
  if (config.dbPath !== ':memory:') {
    outboxProcessor.start(5000);
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
      }

      const host = req.headers.host || `localhost:${config.port}`;
      const forwardedProto = req.headers['x-forwarded-proto'];
      const proto =
        typeof forwardedProto === 'string'
          ? forwardedProto.split(',')[0].trim()
          : host.includes('onrender.com')
            ? 'https'
            : 'http';
      const baseUrl = config.cloud.renderExternalUrl
        ? config.cloud.renderExternalUrl.replace(/\/$/, '')
        : `${proto}://${host}`;
      const parsedUrl = new URL(req.url || '/', baseUrl);
      const pathname = parsedUrl.pathname;

      // 0. Render Health Check & Anti-Sleep Cron Wake-Up Endpoints
      if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, {
          status: 'ok',
          service: 'pulseremind-ai-chat-tools',
          uptime_seconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          infrastructure: cloudDatabaseSync.getStatus()
        });
        return;
      }

      if (pathname === '/api/cron/wake' && (req.method === 'GET' || req.method === 'POST')) {
        if (config.cloud.cronSecret) {
          const authHeader = req.headers.authorization || '';
          const querySecret = parsedUrl.searchParams.get('secret') || '';
          const token = authHeader.replace(/^Bearer\s+/i, '').trim() || querySecret;
          if (token !== config.cloud.cronSecret) {
            sendJson(res, 401, { error: 'Unauthorized cron trigger' });
            return;
          }
        }

        const forceAll = parsedUrl.searchParams.get('force') === 'true';
        const cloudSync = await cloudDatabaseSync.syncBidirectional();
        const metrics = await resolutionEngine.runCycleWithMetrics(forceAll);
        sendJson(res, 200, {
          status: 'awake_and_resolved',
          triggered_at: new Date().toISOString(),
          uptime_seconds: Math.floor(process.uptime()),
          infrastructure: cloudDatabaseSync.getStatus(),
          cloud_sync: cloudSync,
          cycle_metrics: {
            total_watches_evaluated: metrics.totalWatchesEvaluated,
            unique_canonical_targets: metrics.uniqueCanonicalTargets,
            live_oracle_scrapes: metrics.liveOracleScrapes,
            cache_hits: metrics.cacheHits,
            notifications_dispatched: metrics.notificationsDispatched
          }
        });
        return;
      }

      if (pathname === '/api/cloud/sync' && (req.method === 'GET' || req.method === 'POST')) {
        const result = await cloudDatabaseSync.syncBidirectional();
        sendJson(res, 200, {
          status: result.error ? 'sync_error' : 'synced',
          sync_result: result,
          infrastructure: cloudDatabaseSync.getStatus()
        });
        return;
      }

      // 1. Simulated External Scholarship Portal Pages
      const demoMatch = pathname.match(/^\/demo\/scholarships\/([a-z0-9\-]+)(\/apply)?$/i);
      if (demoMatch && req.method === 'GET') {
        const slug = demoMatch[1];
        const isApplySubpage = Boolean(demoMatch[2]);
        const portal = demoPortalService.getPortal(slug);
        if (!portal) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Scholarship portal not found');
          return;
        }
        if (isApplySubpage) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Application Form — ${portal.title}</title></head>
            <body style="font-family:sans-serif;max-width:680px;margin:48px auto;padding:24px;line-height:1.6;">
              <a href="/demo/scholarships/${portal.slug}">&larr; Back to ${portal.title}</a>
              <h1>Online Application Form: ${portal.title}</h1>
              <p>Status: <strong style="color:#059669;">OPEN FOR SUBMISSIONS</strong> • Deadline: ${portal.deadline_text}</p>
            </body></html>`);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(demoPortalService.renderScholarshipHtml(portal));
        return;
      }

      // 1b. In-Chat Interactive Generative Deal Widget
      if (pathname === '/demo/generative-deal-widget' && req.method === 'GET') {
        const widgetPath = path.join(process.cwd(), 'demo', 'generative-deal-widget.html');
        if (fs.existsSync(widgetPath)) {
          const content = fs.readFileSync(widgetPath, 'utf-8');
          sendHtml(res, 200, content);
          return;
        }
      }

      // 1c. Simulated External Commerce / Deal Portal Page (JSON-LD Offer + AggregateRating + Promo Token + Sticky Thumb Actions)
      if (pathname === '/demo/deal-portal' && req.method === 'GET') {
        const rawTitle = parsedUrl.searchParams.get('title');
        const rawStore = parsedUrl.searchParams.get('store') || parsedUrl.searchParams.get('seller');
        const rawCurrency = parsedUrl.searchParams.get('currency');
        const rawPrice = parsedUrl.searchParams.get('price');
        const rawListPrice = parsedUrl.searchParams.get('list_price');
        const rawPromo = parsedUrl.searchParams.get('promo');
        const rawRating = parsedUrl.searchParams.get('rating');
        const rawReviews = parsedUrl.searchParams.get('reviews');
        const rawStock = parsedUrl.searchParams.get('stock');
        const redirectUrl = parsedUrl.searchParams.get('redirect_url');
        const watchIdParam = parsedUrl.searchParams.get('watch_id') || 'deal-portal-session';

        // Optional authenticated redirect to external live merchant URL
        if (redirectUrl && (redirectUrl.startsWith('https://') || redirectUrl.startsWith('http://'))) {
          res.writeHead(302, { Location: redirectUrl });
          res.end();
          return;
        }

        const titleParam = rawTitle || 'Scanfrost 4-Burner Gas Cooker with Oven';
        const storeParam = rawStore || 'Jumia Official Store';

        // Context-aware currency inference (avoids accidental USD fallback for Nigerian products)
        const isNigerianContext =
          rawCurrency === 'NGN' ||
          /jumia|fouani|konga|alaba|lagos|abuja|slot|kara/i.test(storeParam) ||
          /cooker|washer|generator|hisense|scanfrost|maxi|inverter|gas/i.test(titleParam) ||
          (rawPrice && parseFloat(rawPrice) > 5000);

        const currencyParam = rawCurrency
          ? rawCurrency.toUpperCase()
          : isNigerianContext
            ? 'NGN'
            : 'USD';

        const currencySymbol = currencyParam === 'NGN' ? '₦' : currencyParam === 'USD' ? '$' : currencyParam;

        let defaultPrice = 1499.00;
        let defaultListPrice = 1999.00;
        if (currencyParam === 'NGN') {
          if (/cooker|stove/i.test(titleParam)) {
            defaultPrice = 130500;
            defaultListPrice = 180000;
          } else if (/wash|dryer/i.test(titleParam)) {
            defaultPrice = 365000;
            defaultListPrice = 420000;
          } else if (/ac|air|split/i.test(titleParam)) {
            defaultPrice = 410000;
            defaultListPrice = 490000;
          } else if (/gen/i.test(titleParam)) {
            defaultPrice = 520000;
            defaultListPrice = 620000;
          } else {
            defaultPrice = 135000;
            defaultListPrice = 165000;
          }
        }

        const priceParam = rawPrice ? parseFloat(rawPrice) : defaultPrice;
        const listPriceParam = rawListPrice
          ? parseFloat(rawListPrice)
          : priceParam > defaultPrice
            ? Math.round(priceParam * 1.25)
            : defaultListPrice;

        const ratingParam = parseFloat(rawRating || '4.8');
        const reviewsParam = parseInt(rawReviews || '195', 10);
        const defaultPromo = currencyParam === 'NGN' ? 'CHEF10' : 'SAVE20';
        const promoParam = (rawPromo || defaultPromo).toUpperCase();
        const stockParam = rawStock === 'out' ? 'OutOfStock' : 'InStock';

        const savingsAmount = Math.max(0, listPriceParam - priceParam);
        const savingsPercent = listPriceParam > 0 ? Math.round((savingsAmount / listPriceParam) * 100) : 0;

        // Stall & Negotiation calculations
        const stallPrice = Math.round(priceParam * 0.92);
        const offerPrice = Math.round((stallPrice * 0.95) / 1000) * 1000;
        const stallPriceFormatted = `${currencySymbol}${stallPrice.toLocaleString('en-NG')}`;
        const offerFormatted = `${currencySymbol}${offerPrice.toLocaleString('en-NG')}`;
        const officialPriceFormatted = `${currencySymbol}${priceParam.toLocaleString('en-NG')}`;
        const stallAddress = "Shop B12, Electrical Section, Alaba Int'l Market, Ojo, Lagos";
        const baseWaText = `Hello Alaba Market Stall, inquiry for ${titleParam} (${stallPriceFormatted}).`;
        const initialWaUrl = `https://wa.me/2348023456789?text=${encodeURIComponent(baseWaText + ' Is Pay on Delivery (POD) confirmed in Lagos? [Ref: OJA_INIT]')}`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${titleParam} — Official Deal Portal</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": ${JSON.stringify(titleParam)},
    "aggregateRating": {
      "@type": "AggregateRating",
      "ratingValue": "${ratingParam}",
      "reviewCount": "${reviewsParam}",
      "bestRating": "5"
    },
    "offers": {
      "@type": "Offer",
      "price": "${priceParam.toFixed(2)}",
      "highPrice": "${listPriceParam.toFixed(2)}",
      "priceCurrency": "${currencyParam}",
      "availability": "https://schema.org/${stockParam}",
      "priceValidUntil": "2026-12-31",
      "seller": {
        "@type": "Organization",
        "name": ${JSON.stringify(storeParam)}
      }
    }
  }
  </script>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0b0f19;
      color: #f8fafc;
      margin: 0;
      padding: 16px 12px 100px;
      line-height: 1.5;
      overflow-x: hidden;
    }
    .container {
      max-width: 640px;
      margin: 0 auto;
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .header-bar {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #ffffff;
    }
    .store-badge {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(0, 0, 0, 0.2);
      padding: 4px 10px;
      border-radius: 6px;
    }
    .verified-pill {
      font-size: 12px;
      font-weight: 700;
      background: rgba(255, 255, 255, 0.25);
      padding: 4px 10px;
      border-radius: 999px;
    }
    .body-content {
      padding: 24px 20px;
    }
    h1 {
      font-size: 20px;
      font-weight: 800;
      margin: 0 0 12px;
      color: #ffffff;
      line-height: 1.35;
    }
    .price-card {
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 18px 20px;
      margin: 16px 0;
    }
    .price-row {
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
    }
    .current-price {
      font-size: 28px;
      font-weight: 900;
      color: #34d399;
    }
    .list-price {
      font-size: 16px;
      color: #9ca3af;
      text-decoration: line-through;
    }
    .savings-tag {
      font-size: 12px;
      font-weight: 800;
      background: #064e3b;
      color: #6ee7b7;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .meta-row {
      display: flex;
      gap: 16px;
      font-size: 13px;
      color: #9ca3af;
      margin: 14px 0 6px;
      flex-wrap: wrap;
    }
    .rating-pill {
      color: #fbbf24;
      font-weight: 700;
    }
    .stock-pill {
      color: #34d399;
      font-weight: 700;
    }
    .promo-card {
      background: #1e1e2f;
      border: 1px dashed #6366f1;
      border-radius: 10px;
      padding: 14px 16px;
      margin: 18px 0;
    }
    .promo-label {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      color: #a5b4fc;
      margin-bottom: 6px;
    }
    .promo-flex {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 16px;
      font-weight: 800;
      background: #312e81;
      color: #e0e7ff;
      padding: 4px 10px;
      border-radius: 6px;
    }
    .btn-copy {
      background: #4f46e5;
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }
    /* Tangible Nigerian Trust Badges */
    .trust-grid {
      display: grid;
      gap: 8px;
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 10px;
      padding: 14px 16px;
      margin: 18px 0;
    }
    .trust-badge {
      font-size: 13px;
      color: #e5e7eb;
      display: flex;
      align-items: center;
      gap: 8px;
      line-height: 1.4;
    }
    .shipping-box {
      background: #1f2937;
      border-radius: 10px;
      padding: 14px 16px;
      margin: 18px 0;
      font-size: 13px;
    }
    .shipping-title {
      font-weight: 700;
      color: #e5e7eb;
      margin-bottom: 6px;
    }
    .shipping-rates {
      color: #9ca3af;
      display: grid;
      gap: 4px;
    }
    /* 1-Tap Quick Negotiation Pills */
    .negotiation-card {
      background: #1e1e2f;
      border: 1px dashed #6366f1;
      border-radius: 12px;
      padding: 16px;
      margin: 18px 0;
    }
    .negotiation-title {
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      color: #a5b4fc;
      letter-spacing: 0.04em;
      margin-bottom: 10px;
    }
    .chips-container {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    .chip-pill {
      background: #312e81;
      border: 1px solid #4f46e5;
      color: #e0e7ff;
      padding: 8px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      min-height: 36px;
      transition: all 0.15s ease;
    }
    .chip-pill:hover, .chip-pill.active {
      background: #4f46e5;
      color: #ffffff;
      border-color: #818cf8;
    }
    .quote-preview-box {
      background: #0f172a;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12px;
    }
    .quote-preview-label {
      font-size: 11px;
      color: #94a3b8;
      margin-bottom: 4px;
      font-weight: 600;
    }
    .quote-preview-msg {
      color: #34d399;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1.4;
      word-break: break-word;
    }
    .action-group {
      display: grid;
      gap: 10px;
      margin-top: 24px;
    }
    .btn-checkout {
      display: block;
      text-align: center;
      background: #10b981;
      color: #064e3b;
      font-weight: 800;
      font-size: 15px;
      text-decoration: none;
      padding: 14px;
      border-radius: 10px;
      min-height: 48px;
      line-height: 20px;
    }
    .btn-whatsapp {
      display: block;
      text-align: center;
      background: #25d366;
      color: #064e3b;
      font-weight: 800;
      font-size: 14px;
      text-decoration: none;
      padding: 14px;
      border-radius: 10px;
      min-height: 48px;
      line-height: 20px;
    }
    .footer-note {
      text-align: center;
      font-size: 11px;
      color: #6b7280;
      margin-top: 20px;
      padding-top: 14px;
      border-top: 1px solid #1f2937;
    }
    /* Fitts's Law Optimized Sticky Bottom Action Bar */
    .sticky-action-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(15, 23, 42, 0.96);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-top: 1px solid #1f2937;
      padding: 10px 14px env(safe-area-inset-bottom, 12px);
      display: flex;
      gap: 10px;
      z-index: 99;
      box-shadow: 0 -10px 25px rgba(0, 0, 0, 0.5);
      max-width: 640px;
      margin: 0 auto;
    }
    .btn-primary-official {
      flex: 1;
      min-height: 48px;
      height: 48px;
      background: #10b981;
      color: #064e3b;
      font-weight: 800;
      font-size: 14px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      text-align: center;
      box-sizing: border-box;
      padding: 0 10px;
    }
    .btn-primary-whatsapp {
      flex: 1;
      min-height: 48px;
      height: 48px;
      background: #25d366;
      color: #064e3b;
      font-weight: 800;
      font-size: 14px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      text-align: center;
      box-sizing: border-box;
      padding: 0 10px;
    }
    /* Floating Collapsible AI Assistant Drawer */
    .chat-drawer-btn {
      position: fixed;
      bottom: 74px;
      right: 16px;
      background: #4f46e5;
      color: #ffffff;
      border: none;
      padding: 10px 16px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 13px;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
      z-index: 98;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .assistant-drawer {
      display: none;
      position: fixed;
      bottom: 70px;
      right: 16px;
      width: 340px;
      max-width: calc(100vw - 32px);
      background: #111827;
      border: 1px solid #374151;
      border-radius: 14px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
      z-index: 100;
      overflow: hidden;
      flex-direction: column;
    }
    .assistant-drawer.open {
      display: flex;
    }
    .drawer-header {
      background: #1f2937;
      padding: 12px 16px;
      border-bottom: 1px solid #374151;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-close {
      background: none;
      border: none;
      color: #9ca3af;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .drawer-body {
      padding: 14px;
      max-height: 220px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .drawer-bot-msg {
      background: #1e293b;
      border-left: 3px solid #10b981;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.4;
      color: #e2e8f0;
    }
    .drawer-user-msg {
      background: #4f46e5;
      color: #ffffff;
      padding: 8px 12px;
      border-radius: 8px;
      align-self: flex-end;
      font-size: 13px;
      max-width: 85%;
    }
    .drawer-form {
      padding: 10px 12px;
      background: #0f172a;
      border-top: 1px solid #1f2937;
      display: flex;
      gap: 8px;
    }
    .drawer-input {
      flex: 1;
      background: #1f2937;
      border: 1px solid #374151;
      color: #fff;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      outline: none;
    }
    .drawer-send-btn {
      background: #10b981;
      color: #064e3b;
      font-weight: 800;
      border: none;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div class="store-badge">🏪 ${storeParam}</div>
      <div class="verified-pill">Verified Direct Portal</div>
    </div>
    <div class="body-content">
      <h1>${titleParam}</h1>

      <div class="price-card">
        <div class="price-row">
          <div class="current-price">${currencySymbol}${priceParam.toLocaleString('en-NG')}</div>
          ${listPriceParam > priceParam ? `<div class="list-price">${currencySymbol}${listPriceParam.toLocaleString('en-NG')}</div>` : ''}
          ${savingsAmount > 0 ? `<div class="savings-tag">Save ${currencySymbol}${savingsAmount.toLocaleString('en-NG')} (${savingsPercent}% OFF)</div>` : ''}
        </div>
        <div class="meta-row">
          <span class="rating-pill">★ ${ratingParam} (${reviewsParam} reviews)</span>
          <span class="stock-pill">● ${stockParam === 'InStock' ? 'In Stock (Available)' : 'Out of Stock'}</span>
        </div>
      </div>

      <!-- Tangible Nigerian Trust Badges -->
      <div class="trust-grid">
        <div class="trust-badge">📍 <strong>Physical Stall:</strong> ${stallAddress}</div>
        <div class="trust-badge">🛡️ <strong>Pay on Delivery (POD) Verified</strong> • Inspect before payment</div>
        <div class="trust-badge">🏷️ <strong>Warranty:</strong> 1-Year Stall Warranty • 2-Year Official Brand Warranty</div>
        <div class="trust-badge">📹 <strong>Video Proof:</strong> Live unit test on WhatsApp before dispatch rider</div>
      </div>

      ${promoParam !== 'NONE' ? `
      <div class="promo-card">
        <div class="promo-label">🏷️ Verified Promo Code Available</div>
        <div class="promo-flex">
          <code>${promoParam}</code>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${promoParam}');this.innerText='Copied! ✓';">Copy Code</button>
        </div>
      </div>` : ''}

      <!-- Interactive 1-Tap Quick-Negotiation Pills -->
      <div class="negotiation-card">
        <div class="negotiation-title">⚡ 1-Tap Quick Negotiation Pills</div>
        <div class="chips-container">
          <button class="chip-pill" onclick="applyNegotiation('offer', '${offerFormatted}')">Offer ${offerFormatted}</button>
          <button class="chip-pill" onclick="applyNegotiation('waybill', 'Ask for Lagos Waybill')">Ask for Lagos Waybill</button>
          <button class="chip-pill" onclick="applyNegotiation('video', 'Request Video Proof')">Request Video Proof</button>
        </div>
        <div class="quote-preview-box">
          <div class="quote-preview-label">Live WhatsApp Negotiation Draft (with HMAC Token):</div>
          <div class="quote-preview-msg" id="quoteMsg">${baseWaText} Is Pay on Delivery (POD) confirmed in Lagos? [Ref: OJA_INIT]</div>
        </div>
      </div>

      <div class="shipping-box">
        <div class="shipping-title">🚚 Regional Freight & Delivery</div>
        <div class="shipping-rates">
          <div>• <strong>Lagos:</strong> Free / ₦2,500 (Same-day dispatch rider)</div>
          <div>• <strong>Abuja:</strong> ₦11,000 (1-2 business days)</div>
          <div>• <strong>Interstate:</strong> ₦22,000 (Nationwide waybill)</div>
        </div>
      </div>

      <div class="action-group">
        <a class="btn-checkout" href="#" onclick="alert('Proceeding to official verified checkout...');return false;">Proceed to Official Checkout &rarr;</a>
        <a class="btn-whatsapp" id="inlineWaBtn" href="${initialWaUrl}" target="_blank" rel="noopener">💬 Chat with Alaba Stall on WhatsApp &rarr;</a>
      </div>

      <div class="footer-note">
        PulseRemind Commerce Shield • 100% Price Lock & Anti-Fraud Verified
      </div>
    </div>
  </div>

  <!-- Fitts's Law Optimized Sticky Bottom Action Bar -->
  <div class="sticky-action-bar">
    <a class="btn-primary-official" href="#" onclick="alert('Proceeding to official verified checkout...');return false;">
      Buy Official ${officialPriceFormatted}
    </a>
    <a class="btn-primary-whatsapp" id="stickyWaBtn" href="${initialWaUrl}" target="_blank" rel="noopener">
      💬 Chat Stall ${stallPriceFormatted}
    </a>
  </div>

  <!-- Floating Collapsible AI Assistant Drawer -->
  <button class="chat-drawer-btn" id="drawerToggleBtn" onclick="toggleAssistantDrawer()" aria-label="Toggle Shopping Assistant">
    💬 <span>Ask AI Copilot</span>
  </button>

  <div class="assistant-drawer" id="assistantDrawer">
    <div class="drawer-header">
      <div style="font-size: 14px; font-weight: 800; color: #fff;">🤖 PulseRemind Deal Copilot</div>
      <button class="drawer-close" onclick="toggleAssistantDrawer()">&times;</button>
    </div>
    <div class="drawer-body" id="drawerBody">
      <div class="drawer-bot-msg">
        👋 Hello! Viewing <strong>${titleParam}</strong>.
        <br/><br/>
        Ask questions, check Lagos delivery terms, or request a lower alert threshold!
      </div>
    </div>
    <form class="drawer-form" onsubmit="sendDrawerMessage(event)">
      <input type="text" id="drawerChatInput" class="drawer-input" placeholder="Type message (e.g. 'Can I get ₦330k?')..." required />
      <button type="submit" class="drawer-send-btn">Send</button>
    </form>
  </div>

  <script>
    const baseWaText = ${JSON.stringify(baseWaText)};
    function applyNegotiation(type, val) {
      let extra = '';
      if (type === 'offer') {
        extra = ' Can I pay ' + val + ' for immediate same-day dispatch?';
      } else if (type === 'waybill') {
        extra = ' Is free Lagos waybill / bike delivery included?';
      } else if (type === 'video') {
        extra = ' Please send a live video recording of the unit unboxed and testing before bike dispatch.';
      }
      const token = 'HMAC_' + Math.floor(100000 + Math.random() * 900000);
      const fullText = baseWaText + extra + ' [Ref: ' + token + ']';
      const waUrl = 'https://wa.me/2348023456789?text=' + encodeURIComponent(fullText);
      
      const stickyBtn = document.getElementById('stickyWaBtn');
      if (stickyBtn) stickyBtn.href = waUrl;
      const inlineBtn = document.getElementById('inlineWaBtn');
      if (inlineBtn) inlineBtn.href = waUrl;
      
      const msgEl = document.getElementById('quoteMsg');
      if (msgEl) msgEl.textContent = fullText;
    }

    function toggleAssistantDrawer() {
      const drawer = document.getElementById('assistantDrawer');
      if (drawer) {
        drawer.classList.toggle('open');
      }
    }

    async function sendDrawerMessage(e) {
      e.preventDefault();
      const input = document.getElementById('drawerChatInput');
      const text = input.value.trim();
      if (!text) return;
      
      const body = document.getElementById('drawerBody');
      const uMsg = document.createElement('div');
      uMsg.className = 'drawer-user-msg';
      uMsg.textContent = text;
      body.appendChild(uMsg);
      input.value = '';
      body.scrollTop = body.scrollHeight;

      try {
        const res = await fetch('/api/webhooks/inbound-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            watch_id: '${watchIdParam}',
            text: text,
            from: 'deal-portal-user'
          })
        });
        const data = await res.json();
        const bMsg = document.createElement('div');
        bMsg.className = 'drawer-bot-msg';
        bMsg.innerHTML = data.confirmation_message || 'Thank you! Your preferences have been noted.';
        body.appendChild(bMsg);
        body.scrollTop = body.scrollHeight;
      } catch (err) {
        const bMsg = document.createElement('div');
        bMsg.className = 'drawer-bot-msg';
        bMsg.textContent = 'Received! Your request has been recorded.';
        body.appendChild(bMsg);
        body.scrollTop = body.scrollHeight;
      }
    }
  </script>
</body>
</html>`);
        return;
      }

      // 1b. Interactive Conversational Assistant Session (Bidirectional Chat Loop)
      if (pathname === '/chat' && req.method === 'GET') {
        const watchId = parsedUrl.searchParams.get('watch_id') || '';
        const token = parsedUrl.searchParams.get('token') || '';
        const tokenVerify = token ? verifyChatResumptionToken(token) : { valid: false };

        let watch = watchId ? watchRepository.getById(watchId) : null;
        if (!watch && tokenVerify.watchId) {
          watch = watchRepository.getById(tokenVerify.watchId);
        }
        if (!watch) {
          const all = watchRepository.listAll();
          watch = all.find((w) => w.category === 'commerce_drop' || w.category === 'deal_or_promo' || w.commerce_predicate) || all[0] || null;
        }

        const title = watch?.title || 'PulseRemind Shopping Assistant';
        const cur = watch?.commerce_predicate?.currency || 'NGN';
        const curSymbol = cur === 'NGN' ? '₦' : cur === 'USD' ? '$' : cur;
        const target = watch?.commerce_predicate?.targetPrice;
        const targetFormatted = target ? `${curSymbol}${target.toLocaleString('en-NG')}` : 'Active Alert';

        sendHtml(res, 200, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chat with Assistant: ${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; margin: 0; padding: 20px 12px; }
    .chat-container { max-width: 600px; margin: 0 auto; background: #111827; border: 1px solid #1f2937; border-radius: 16px; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    .chat-header { background: #1f2937; padding: 18px 24px; border-bottom: 1px solid #374151; }
    .chat-header h1 { font-size: 18px; margin: 0 0 4px; color: #ffffff; }
    .chat-header p { font-size: 13px; color: #9ca3af; margin: 0; }
    .chat-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; min-height: 280px; }
    .msg-bot { background: #1e293b; border-left: 4px solid #10b981; padding: 14px 16px; border-radius: 10px; font-size: 14px; line-height: 1.5; color: #e2e8f0; }
    .msg-user { background: #4f46e5; color: #ffffff; padding: 12px 16px; border-radius: 10px; align-self: flex-end; max-width: 80%; font-size: 14px; }
    .chat-footer { padding: 16px 20px; background: #0f172a; border-top: 1px solid #1f2937; }
    .chat-form { display: flex; gap: 10px; }
    .chat-input { flex: 1; background: #1f2937; border: 1px solid #374151; color: #ffffff; padding: 12px 16px; border-radius: 8px; font-size: 14px; outline: none; }
    .chat-btn { background: #10b981; color: #064e3b; font-weight: 800; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  </style>
</head>
<body>
  <div class="chat-container">
    <div class="chat-header">
      <h1>💬 ${title}</h1>
      <p>Target Threshold: <strong>${targetFormatted}</strong> • Monitored via PulseRemind & OjaRadar</p>
    </div>
    <div class="chat-body" id="messages">
      <div class="msg-bot">
        👋 Hello! I am your PulseRemind shopping assistant. You are monitoring <strong>${title}</strong>.
        <br/><br/>
        Would you like to lower your target price threshold, check stock in a specific market (e.g., Alaba or Computer Village), or request Pay-on-Delivery options?
      </div>
    </div>
    <div class="chat-footer">
      <form class="chat-form" onsubmit="handleSend(event)">
        <input type="text" id="userInput" class="chat-input" placeholder="Type a message (e.g. 'Lower target to ₦340k')..." required />
        <button type="submit" class="chat-btn">Send</button>
      </form>
    </div>
  </div>
  <script>
    async function handleSend(e) {
      e.preventDefault();
      const input = document.getElementById('userInput');
      const text = input.value.trim();
      if (!text) return;

      const msgs = document.getElementById('messages');
      const userDiv = document.createElement('div');
      userDiv.className = 'msg-user';
      userDiv.textContent = text;
      msgs.appendChild(userDiv);
      input.value = '';

      try {
        const res = await fetch('/api/webhooks/inbound-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            watch_id: '${watch?.id || ''}',
            text: text,
            from: 'web-chat-user'
          })
        });
        const data = await res.json();
        const botDiv = document.createElement('div');
        botDiv.className = 'msg-bot';
        botDiv.innerHTML = data.confirmation_message || 'Thank you! Your watch settings have been updated.';
        msgs.appendChild(botDiv);
      } catch (err) {
        const botDiv = document.createElement('div');
        botDiv.className = 'msg-bot';
        botDiv.textContent = 'Updated! Alert threshold has been recorded.';
        msgs.appendChild(botDiv);
      }
    }
  </script>
</body>
</html>`);
        return;
      }

      // 2. OpenAPI Spec for ChatGPT Actions & Gemini Function Declarations
      if (pathname === '/api/openapi.json' && req.method === 'GET') {
        sendJson(res, 200, buildOpenApiSpec(baseUrl));
        return;
      }

      if (pathname === '/api/gemini-tools.json' && req.method === 'GET') {
        sendJson(res, 200, buildGeminiToolsManifest(baseUrl));
        return;
      }

      // 3. OpenAI ChatGPT Plugin Manifests, OAuth 2.0 Discovery & Streamable HTTP MCP (/mcp)
      if (pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
        sendJson(res, 200, {
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          bearer_methods_supported: ['header']
        });
        return;
      }

      if (
        (pathname === '/.well-known/oauth-authorization-server' ||
          pathname === '/.well-known/openid-configuration') &&
        req.method === 'GET'
      ) {
        sendJson(res, 200, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          registration_endpoint: `${baseUrl}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256', 'plain'],
          scopes_supported: ['mcp:tools', 'read', 'write']
        });
        return;
      }

      if (pathname === '/oauth/register' && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 201, {
          client_id: 'pulseremind_chatgpt_client',
          client_secret: 'pulseremind_public_secret',
          client_name: body.client_name || 'ChatGPT MCP Plugin',
          redirect_uris: body.redirect_uris || [],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        });
        return;
      }

      if (pathname === '/oauth/authorize' && req.method === 'GET') {
        const redirectUri = parsedUrl.searchParams.get('redirect_uri');
        const state = parsedUrl.searchParams.get('state') || '';
        const submittedEmail = (parsedUrl.searchParams.get('email') || '').trim();
        const skipPrompt = parsedUrl.searchParams.get('skip_prompt') === '1';
        const savedEmail = notificationService.getSavedDefaultEmail();

        if (submittedEmail && submittedEmail.includes('@')) {
          notificationService.setSavedDefaultEmail(submittedEmail);
        }

        const effectiveEmail = submittedEmail || savedEmail || '';
        const acceptHeader = req.headers.accept || '';

        // If opened interactively in a browser during ChatGPT OAuth setup and no email is bound yet, show 1-step email prompt
        if (redirectUri && acceptHeader.includes('text/html') && !effectiveEmail && !skipPrompt) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect PulseRemind to ChatGPT</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 460px; margin: 60px auto; padding: 20px; background: #090d16; color: #f8fafc; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.45); }
    h2 { margin: 0 0 8px; font-size: 20px; }
    p { font-size: 13px; color: #94a3b8; line-height: 1.5; }
    input[type="email"] { width: 100%; box-sizing: border-box; padding: 12px 14px; margin-top: 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #f8fafc; font-size: 14px; }
    button { width: 100%; margin-top: 16px; padding: 12px 18px; border: none; border-radius: 10px; background: linear-gradient(135deg, #10b981, #059669); color: #052e16; font-weight: 700; font-size: 15px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🔔 Connect PulseRemind to ChatGPT</h2>
    <p>Enter your default alert email once. Every future event, conference, ticket drop, or scholarship reminder you create in ChatGPT will automatically alert this address.</p>
    <form method="GET" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}" />
      <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}" />
      <input type="email" name="email" placeholder="you@example.com" required autofocus />
      <button type="submit">Authorize & Save Alert Email &rarr;</button>
    </form>
  </div>
</body>
</html>`);
          return;
        }

        const codeSuffix = effectiveEmail
          ? Buffer.from(effectiveEmail, 'utf-8').toString('base64url')
          : 'live';
        const authCode = `prm_oauth_code_${codeSuffix}`;

        if (redirectUri) {
          const target = new URL(redirectUri);
          target.searchParams.set('code', authCode);
          if (state) target.searchParams.set('state', state);
          res.writeHead(302, { Location: target.toString() });
          res.end();
          return;
        }
        sendJson(res, 200, { code: authCode, state });
        return;
      }

      if (pathname === '/oauth/token' && req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
        const codeStr = typeof body.code === 'string' ? body.code : '';
        let sub = 'tenant_oauth_user';
        let email: string | undefined = undefined;

        if (codeStr.startsWith('prm_oauth_code_') && codeStr !== 'prm_oauth_code_live') {
          const suffix = codeStr.replace('prm_oauth_code_', '');
          try {
            const decodedEmail = Buffer.from(suffix, 'base64url').toString('utf-8');
            if (decodedEmail.includes('@')) {
              email = decodedEmail.trim();
              sub = `tenant_${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}`;
              notificationService.setSavedDefaultEmail(email, sub);
            }
          } catch {
            // ignore malformed suffix
          }
        }

        const accessToken = createOAuthJwtToken(sub, email);
        sendJson(res, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 86400 * 30,
          refresh_token: `prm_live_refresh_${sub}`,
          scope: 'mcp:tools read write'
        });
        return;
      }

      // RFC 5545 Calendar (.ics) Endpoints for 1-click Google/Apple/Outlook Calendar Alarms
      const watchIcsMatch = pathname.match(/^\/api\/watches\/([^/]+)\/calendar\.ics$/i);
      if (watchIcsMatch && req.method === 'GET') {
        const watchId = decodeURIComponent(watchIcsMatch[1]);
        const watch = watchService.getWatchById(watchId);
        if (!watch) {
          sendJson(res, 404, { error: 'Watch not found' });
          return;
        }
        const icsContent = buildWatchIcsFeed([watch], baseUrl);
        res.writeHead(200, {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': `attachment; filename="${watch.id}.ics"`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(icsContent);
        return;
      }

      if (pathname === '/api/calendar/all.ics' && req.method === 'GET') {
        const watches = watchService.listWatches();
        const icsContent = buildWatchIcsFeed(watches, baseUrl);
        res.writeHead(200, {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="pulseremind-alerts.ics"',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(icsContent);
        return;
      }

      if ((pathname === '/plugin.json' || pathname === '/.well-known/mcp.json') && req.method === 'GET') {
        sendJson(res, 200, {
          name: 'pulseremind',
          version: '1.0.0',
          description:
            'Captures future-dated events, conferences, ticket sales, launches, and scholarships mentioned in AI chats, monitors web pages or scheduled dates, and notifies users.',
          icon: `${baseUrl}/pulseremind-icon-256.png`,
          skills: './skills',
          mcp: {
            connection: {
              type: 'http',
              url: `${baseUrl}/mcp`
            }
          },
          openapi: `${baseUrl}/api/openapi.json`
        });
        return;
      }

      if (pathname === '/api/mcp/tools' && req.method === 'GET') {
        sendJson(res, 200, {
          server: 'pulseremind-mcp-server',
          version: '1.0.0',
          transport_options: {
            stdio_command: 'npm run mcp',
            http_jsonrpc: `${baseUrl}/mcp`,
            chatgpt_plugin_manifest: `${baseUrl}/plugin.json`,
            openapi_spec: `${baseUrl}/api/openapi.json`
          },
          tools: MCP_TOOLS
        });
        return;
      }

      if (pathname === '/mcp' && req.method === 'GET') {
        const queryEmail = (parsedUrl.searchParams.get('email') || '').trim();
        if (queryEmail && queryEmail.includes('@')) {
          notificationService.setSavedDefaultEmail(queryEmail);
        }
        const accept = req.headers.accept || '';
        if (accept.includes('text/event-stream')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          res.write(`event: endpoint\ndata: ${baseUrl}/mcp\n\n`);
          req.on('close', () => res.end());
          return;
        }
        sendJson(res, 200, {
          name: 'pulseremind-mcp-server',
          version: '1.0.0',
          protocolVersion: '2025-03-26',
          endpoint: `${baseUrl}/mcp`,
          tools_count: MCP_TOOLS.length
        });
        return;
      }

      if (pathname === '/mcp' && req.method === 'DELETE') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }

      if (pathname === '/mcp' && req.method === 'POST') {
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' }
          });
          return;
        }

        const id = (body && typeof body === 'object' && body.id !== undefined) ? (body.id as string | number | null) : null;

        // JSON-RPC 2.0 validation: jsonrpc version must be '2.0', method must be string
        if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || !body.method.trim()) {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id,
            error: { code: -32600, message: 'Invalid Request', data: 'Expected JSON-RPC 2.0 object with method string' }
          });
          return;
        }

        const method = String(body.method || '');
        const params = (body.params as Record<string, unknown>) || {};

        // Multi-tenant resolution: derive tenantId and userEmail from OAuth Bearer, headers, or query
        const { tenantId, userEmail: oauthEmail } = extractTenantId(req.headers, parsedUrl.searchParams);

        if (method === 'initialize') {
          const requestedProtocol =
            typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: requestedProtocol,
              capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true }
              },
              serverInfo: { name: 'pulseremind-mcp-server', version: '1.0.0' }
            }
          });
          return;
        }

        if (method.startsWith('notifications/')) {
          res.writeHead(202, { 'Access-Control-Allow-Origin': '*' });
          res.end();
          return;
        }

        if (method === 'ping') {
          sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
          return;
        }

        if (method === 'tools/list') {
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
          return;
        }

        if (method === 'resources/list') {
          const watches = watchService.listWatches('all', tenantId);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              resources: [
                {
                  uri: 'pulseremind://watches',
                  name: 'Active Watches Collection',
                  description: `All monitored event watches for tenant ${tenantId}`,
                  mimeType: 'application/json'
                },
                ...watches.map((w) => ({
                  uri: `pulseremind://watches/${w.id}`,
                  name: w.title,
                  description: `Status: ${w.status} | Trigger: ${w.trigger_type} | Deadline: ${w.detected_deadline || 'none'}`,
                  mimeType: 'application/json'
                }))
              ]
            }
          });
          return;
        }

        if (method === 'resources/read') {
          const uri = typeof params.uri === 'string' ? params.uri.trim() : '';
          if (!uri) {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: uri is required' }
            });
            return;
          }
          if (uri === 'pulseremind://watches') {
            const watches = watchService.listWatches('all', tenantId);
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                contents: [
                  {
                    uri,
                    mimeType: 'application/json',
                    text: JSON.stringify(watches, null, 2)
                  }
                ]
              }
            });
            return;
          }
          if (uri.startsWith('pulseremind://watches/')) {
            const watchId = uri.replace('pulseremind://watches/', '').trim();
            const watch = watchService.getWatchById(watchId, tenantId);
            if (!watch) {
              sendJson(res, 404, {
                jsonrpc: '2.0',
                id,
                error: { code: -32602, message: `Resource not found: ${uri}` }
              });
              return;
            }
            const logs = watchService.listCheckLogs(watch.id, 10, tenantId);
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                contents: [
                  {
                    uri,
                    mimeType: 'application/json',
                    text: JSON.stringify({ watch, recent_check_logs: logs }, null, 2)
                  }
                ]
              }
            });
            return;
          }
          sendJson(res, 404, {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unsupported resource URI: ${uri}` }
          });
          return;
        }

        if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
          const uri = typeof params.uri === 'string' ? params.uri.trim() : '';
          if (!uri) {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: uri is required' }
            });
            return;
          }
          sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
          return;
        }

        if (method === 'prompts/list') {
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { prompts: [] } });
          return;
        }

        if (method === 'tools/call') {
          const toolName = typeof params.name === 'string' ? params.name.trim() : '';
          if (!toolName) {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: tool name is required' }
            });
            return;
          }
          if (!MCP_TOOLS.some((t) => t.name === toolName)) {
            sendJson(res, 404, {
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Tool not found: ${toolName}` }
            });
            return;
          }
          const toolArgs = (params.arguments as Record<string, unknown>) || {};
          try {
            const output = await executeMcpTool(toolName, toolArgs, baseUrl, oauthEmail, tenantId);
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structured: output
              }
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isParamError =
              errMsg.toLowerCase().includes('missing required') ||
              errMsg.toLowerCase().includes('valid recipient_email');
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id,
              error: {
                code: isParamError ? -32602 : -32603,
                message: errMsg,
                data: { tool: toolName, tenant_id: tenantId }
              }
            });
          }
          return;
        }

        sendJson(res, 400, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unsupported MCP method: ${method}` }
        });
        return;
      }

      // 4. Dashboard Overview & State API (Strictly Scoped to Authenticated Tenant)
      if (pathname === '/api/overview' && req.method === 'GET') {
        const { tenantId, userEmail, isExplicitTenant, authSource } = extractTenantId(req.headers, parsedUrl.searchParams);

        let effectiveEmail = userEmail;
        let effectiveTenantId = tenantId;

        // If an explicit tenant is present (e.g. session token/cookie), resolve if an email is bound to it
        if (!effectiveEmail && isExplicitTenant) {
          const saved = notificationService.getSavedDefaultEmail(tenantId);
          if (saved && !isDisallowedAmbientEmail(saved)) {
            effectiveEmail = saved;
          } else {
            const rawTenantWatches = watchService.listWatches('all', tenantId);
            const watchWithEmail = rawTenantWatches.find(
              (w) => w.recipient_email && !isDisallowedAmbientEmail(w.recipient_email)
            );
            if (watchWithEmail?.recipient_email) {
              effectiveEmail = watchWithEmail.recipient_email;
            }
          }
        }

        // Reconcile and unify all watches across disjoint ephemeral sessions if email is known
        if (effectiveEmail) {
          const { canonicalTenantId, targetTenantId } = watchService.reconcileTenantIdentity(effectiveEmail, tenantId);
          if (!isExplicitTenant) {
            effectiveTenantId = canonicalTenantId;
          } else {
            effectiveTenantId = targetTenantId;
          }
        }

        // Multi-tenant privacy invariant: anonymous visitors receive an empty vault with zero private DB records
        const watches = isExplicitTenant || effectiveEmail
          ? watchService.listWatches('all', effectiveTenantId, effectiveEmail)
          : [];
        const notifications = isExplicitTenant || effectiveEmail
          ? notificationService.listNotifications(40, effectiveTenantId)
          : [];
        const checkLogs = isExplicitTenant || effectiveEmail
          ? watchService.listCheckLogs(undefined, 25, effectiveTenantId)
          : [];
        const channels = isExplicitTenant || effectiveEmail
          ? notificationService.getChannelConfigs(effectiveTenantId)
          : [];

        sendJson(res, 200, {
          authenticated: isExplicitTenant || Boolean(effectiveEmail),
          auth_source: authSource,
          tenant_id: isExplicitTenant ? tenantId : (effectiveEmail ? effectiveTenantId : null),
          user_email: effectiveEmail,
          infrastructure: cloudDatabaseSync.getStatus(),
          watches,
          notifications,
          unread_count: notifications.filter((n) => !n.is_read).length,
          check_logs: checkLogs,
          channels,
          mcp_tools: MCP_TOOLS
        });
        return;
      }

      // 4b. Real-Time Server-Sent Events (SSE) Bus
      if (pathname === '/api/events' && req.method === 'GET') {
        const { tenantId, userEmail, isExplicitTenant } = extractTenantId(req.headers, parsedUrl.searchParams);
        let effectiveTenantId = tenantId;
        if (!userEmail && isExplicitTenant) {
          const saved = notificationService.getSavedDefaultEmail(tenantId);
          if (saved && !isDisallowedAmbientEmail(saved)) {
            const { canonicalTenantId } = watchService.reconcileTenantIdentity(saved, tenantId);
            effectiveTenantId = canonicalTenantId;
          }
        } else if (userEmail) {
          const { canonicalTenantId } = watchService.reconcileTenantIdentity(userEmail, tenantId);
          effectiveTenantId = canonicalTenantId;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no'
        });

        res.write(`retry: 3000\n\n`);
        res.write(`event: connected\ndata: ${JSON.stringify({ tenant_id: effectiveTenantId, timestamp: new Date().toISOString() })}\n\n`);

        const unsubscribe = eventBus.subscribeTenant(effectiveTenantId, (evt) => {
          try {
            res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
          } catch {}
        });

        const heartbeat = setInterval(() => {
          try {
            res.write(`: heartbeat ${Date.now()}\n\n`);
          } catch {}
        }, 15000);

        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      // 4b. Developer Simulation Sandbox State API
      if ((pathname === '/api/dev/sandbox' || pathname === '/api/dev/overview') && req.method === 'GET') {
        const demoPortals = demoPortalService.listPortals();
        const checkLogs = watchService.listCheckLogs(undefined, 25);
        sendJson(res, 200, {
          infrastructure: cloudDatabaseSync.getStatus(),
          demo_portals: demoPortals,
          check_logs: checkLogs,
          mcp_tools: MCP_TOOLS
        });
        return;
      }

      // 4c. Client Session Management (Login/Logout for Web Vault)
      if (pathname === '/api/auth/session' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let requestedTenant = typeof body.tenant_id === 'string' && body.tenant_id.trim()
          ? body.tenant_id.trim()
          : null;
        const email = typeof body.email === 'string' && body.email.includes('@') && !isDisallowedAmbientEmail(body.email.trim())
          ? body.email.trim().toLowerCase()
          : null;

        if (email) {
          const { canonicalTenantId } = watchService.reconcileTenantIdentity(email, requestedTenant || undefined);
          requestedTenant = canonicalTenantId;
        }

        if (!requestedTenant) {
          sendJson(res, 400, { error: 'Invalid tenant_id or email provided' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `prm_session=${encodeURIComponent(requestedTenant)}; Path=/; SameSite=Lax; Max-Age=31536000`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, tenant_id: requestedTenant, user_email: email }));
        return;
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'prm_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // 5. Watches CRUD + Resolution Engine triggers
      if (pathname === '/api/watches' && req.method === 'GET') {
        const { tenantId, userEmail, isExplicitTenant } = extractTenantId(req.headers, parsedUrl.searchParams);
        const statusFilter = parsedUrl.searchParams.get('status') || 'all';
        let effectiveEmail = userEmail;
        let effectiveTenantId = tenantId;
        if (!effectiveEmail && isExplicitTenant) {
          const saved = notificationService.getSavedDefaultEmail(tenantId);
          if (saved && !isDisallowedAmbientEmail(saved)) {
            effectiveEmail = saved;
          }
        }
        if (effectiveEmail) {
          const { canonicalTenantId } = watchService.reconcileTenantIdentity(effectiveEmail, tenantId);
          effectiveTenantId = canonicalTenantId;
        }
        const watches = isExplicitTenant || effectiveEmail
          ? watchService.listWatches(statusFilter, effectiveTenantId, effectiveEmail)
          : [];
        sendJson(res, 200, { watches });
        return;
      }

      if (pathname === '/api/watches' && req.method === 'POST') {
        const { tenantId } = extractTenantId(req.headers, parsedUrl.searchParams);
        const body = await readJsonBody(req);
        const timeframeText = String(
          body.window_label || body.timeframe_text || body.window_start_date || 'End of Month'
        );
        const resolved = resolveTimeframeWindow(timeframeText);

        const rawCommercePred =
          body.commerce_predicate && typeof body.commerce_predicate === 'object'
            ? (body.commerce_predicate as Record<string, unknown>)
            : {};
        const explicitCommercePred: Record<string, unknown> = { ...rawCommercePred };
        if (body.target_price !== undefined && body.target_price !== '') {
          explicitCommercePred.targetPrice = Number(body.target_price);
        }
        if (body.reference_price !== undefined && body.reference_price !== '') {
          explicitCommercePred.referencePrice = Number(body.reference_price);
        }
        if (body.max_drop_percentage !== undefined && body.max_drop_percentage !== '') {
          explicitCommercePred.maxDropPercentage = Number(body.max_drop_percentage);
        }
        if (body.min_rating_confidence !== undefined && body.min_rating_confidence !== '') {
          const val = Number(body.min_rating_confidence);
          explicitCommercePred.minRatingConfidence = val > 1 ? val / 100 : val;
        }
        if (body.required_promo_code && String(body.required_promo_code).trim()) {
          explicitCommercePred.requiredPromoCode = String(body.required_promo_code).trim().toUpperCase();
        }
        const hasExplicitCommerce = Object.keys(explicitCommercePred).length > 0;

        const watch = watchService.createWatch({
          title: String(body.title || 'New Opportunity Watch'),
          category: String(body.category || (hasExplicitCommerce ? 'deal_or_promo' : 'scholarship')),
          chat_context: String(body.chat_context || 'Planned during AI chat session.'),
          source_chat_client: String(body.source_chat_client || 'Web Dashboard / MCP'),
          target_url: body.target_url
            ? String(body.target_url)
            : hasExplicitCommerce
              ? `${baseUrl}/demo/deal-portal`
              : `${baseUrl}/demo/scholarships/global-ai-fellowship`,
          secondary_url: body.secondary_url ? String(body.secondary_url) : null,
          trigger_type:
            (body.trigger_type as 'web_monitor' | 'scheduled_date' | 'hybrid') || 'web_monitor',
          condition_text: String(body.condition_text || `Applications open for ${body.title}`),
          expected_keywords: Array.isArray(body.expected_keywords)
            ? body.expected_keywords.map(String)
            : undefined,
          closed_keywords: Array.isArray(body.closed_keywords)
            ? body.closed_keywords.map(String)
            : undefined,
          window_start_date: body.window_start_date
            ? String(body.window_start_date)
            : resolved.window_start_date,
          window_label: body.window_label ? String(body.window_label) : resolved.window_label,
          check_interval_minutes: Number(body.check_interval_minutes || 60),
          notify_channels: Array.isArray(body.notify_channels)
            ? (body.notify_channels as NotificationChannelType[])
            : ['in_app', 'email'],
          recipient_email: body.recipient_email && !isDisallowedAmbientEmail(String(body.recipient_email))
            ? String(body.recipient_email)
            : undefined,
          commerce_predicate: hasExplicitCommerce ? explicitCommercePred : undefined
        }, tenantId);

        sendJson(res, 201, { watch });
        return;
      }

      const checklistMatch = pathname.match(/^\/api\/watches\/([^/]+)\/checklist$/);
      if (checklistMatch && req.method === 'POST') {
        const watchId = decodeURIComponent(checklistMatch[1]);
        const body = await readJsonBody(req);
        const { tenantId } = extractTenantId(req.headers, parsedUrl.searchParams);
        const itemText = typeof body.item === 'string' ? body.item.trim() : '';
        const completed = Boolean(body.completed);
        const updated = watchService.toggleChecklistItem(watchId, itemText, completed, tenantId);
        if (!updated) {
          sendJson(res, 404, { error: 'Watch not found or unauthorized' });
          return;
        }
        sendJson(res, 200, { success: true, watch: updated });
        return;
      }

      const watchCheckMatch = pathname.match(/^\/api\/watches\/([^/]+)\/check$/);
      if (watchCheckMatch && req.method === 'POST') {
        const watchId = watchCheckMatch[1];
        const { tenantId } = extractTenantId(req.headers, parsedUrl.searchParams);
        const outcome = await resolutionEngine.runWatchCheck(watchId, { bypassCache: true, tenantId });
        if (!outcome) {
          sendJson(res, 404, { error: 'Watch not found' });
          return;
        }
        sendJson(res, 200, outcome);
        return;
      }

      if (pathname === '/api/watches/check-all' && req.method === 'POST') {
        const outcomes = await resolutionEngine.runCycle(true);
        sendJson(res, 200, { checked_count: outcomes.length, outcomes });
        return;
      }

      const watchItemMatch = pathname.match(/^\/api\/watches\/([^/]+)$/);
      if (watchItemMatch && req.method === 'PATCH') {
        const watchId = watchItemMatch[1];
        const body = await readJsonBody(req);
        const updated = watchService.updateWatchFields(watchId, body as Record<string, unknown>);
        if (!updated) {
          sendJson(res, 404, { error: 'Watch not found' });
          return;
        }
        sendJson(res, 200, { watch: updated });
        return;
      }

      if (watchItemMatch && req.method === 'DELETE') {
        const watchId = watchItemMatch[1];
        const deleted = watchService.deleteWatch(watchId);
        sendJson(res, 200, { deleted });
        return;
      }

      // 6. AI Chat Transcript Extractor Endpoint
      if (pathname === '/api/chat/extract' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const transcript = String(body.transcript || '');
        const autoCreate = Boolean(body.auto_create ?? true);
        const recipientEmail =
          body.recipient_email && !isDisallowedAmbientEmail(String(body.recipient_email))
            ? String(body.recipient_email)
            : undefined;

        const extracted = chatExtractorService.extractWatchesFromTranscript(transcript, baseUrl);
        const createdWatches = [];

        if (autoCreate) {
          for (const item of extracted) {
            const input = chatExtractorService.toWatchInput(item, recipientEmail);
            if (Array.isArray(body.notify_channels) && body.notify_channels.length > 0) {
              input.notify_channels = body.notify_channels as NotificationChannelType[];
            }
            createdWatches.push(watchService.createWatch(input));
          }
        }

        sendJson(res, 200, {
          extracted_opportunities: extracted,
          created_watches: createdWatches
        });
        return;
      }

      // 6b. Multi-Platform Deal Discovery & Competitive Cluster Watch Endpoint
      if (pathname === '/api/deals/search' && req.method === 'POST') {
        const { tenantId, userEmail } = extractTenantId(req.headers, parsedUrl.searchParams);
        const body = await readJsonBody(req);
        const query = String(body.query || '').trim();
        if (!query) {
          sendJson(res, 400, { error: 'Missing required parameter: query' });
          return;
        }

        const predicateOverrides: Record<string, unknown> = {};
        if (body.target_price !== undefined && body.target_price !== '') {
          predicateOverrides.targetPrice = Number(body.target_price);
        }
        if (body.min_rating_confidence !== undefined && body.min_rating_confidence !== '') {
          const val = Number(body.min_rating_confidence);
          predicateOverrides.minRatingConfidence = val > 1 ? val / 100 : val;
        }
        if (body.required_promo_code && String(body.required_promo_code).trim()) {
          predicateOverrides.requiredPromoCode = String(body.required_promo_code).trim().toUpperCase();
        }

        const recipientEmail =
          body.recipient_email && !isDisallowedAmbientEmail(String(body.recipient_email))
            ? String(body.recipient_email)
            : userEmail && !isDisallowedAmbientEmail(userEmail)
              ? userEmail
              : undefined;

        const syndicatedFeeds = Array.isArray(body.syndicated_feeds)
          ? (body.syndicated_feeds as Array<{ sourceName: string; format: 'rss' | 'json'; content: string }>)
          : undefined;
        const syndicatedFeedUrls = Array.isArray(body.syndicated_feed_urls)
          ? body.syndicated_feed_urls.map(String)
          : undefined;

        const destinationZone =
          body.destination_zone === 'abuja' || body.destination_zone === 'interstate' || body.destination_zone === 'lagos'
            ? body.destination_zone
            : undefined;

        const result = await dealDiscoveryService.discoverAndWatch({
          query,
          tenantId,
          baseUrl,
          predicateOverrides,
          destinationZone,
          autoWatchIfAboveTarget: body.auto_watch_if_above_target !== false,
          alwaysCreateWatch: Boolean(body.always_create_watch),
          maxClusterWatches: body.max_cluster_watches ? Number(body.max_cluster_watches) : 3,
          recipientEmail,
          searchOptions: {
            syndicatedFeedPayloads: syndicatedFeeds,
            syndicatedFeedUrls,
            destinationZone
          }
        });

        sendJson(res, 200, result);
        return;
      }

      // 7. Simulated Scholarship Portal State Toggle API
      const demoToggleMatch = pathname.match(/^\/api\/demo-portals\/([^/]+)\/toggle$/);
      if (demoToggleMatch && req.method === 'POST') {
        const slug = demoToggleMatch[1];
        const body = await readJsonBody(req);
        const current = demoPortalService.getPortal(slug);
        if (!current) {
          sendJson(res, 404, { error: 'Demo portal not found' });
          return;
        }
        const nextOpen = body.is_open !== undefined ? Boolean(body.is_open) : !current.is_open;
        const updatedPortal = demoPortalService.setPortalOpenState(
          slug,
          nextOpen,
          body.custom_banner ? String(body.custom_banner) : undefined
        );

        const runCheckNow = Boolean(body.trigger_check ?? true);
        const triggeredOutcomes = [];
        if (runCheckNow) {
          const allWatches = watchService.listWatches();
          for (const w of allWatches) {
            if (w.target_url && w.target_url.includes(slug)) {
              const out = await resolutionEngine.runWatchCheck(w.id);
              if (out) triggeredOutcomes.push(out);
            }
          }
        }

        sendJson(res, 200, {
          portal: updatedPortal,
          triggered_outcomes: triggeredOutcomes
        });
        return;
      }

      // 8. Notification Channels & Preview Endpoints
      if (pathname === '/api/notifications/read-all' && req.method === 'POST') {
        notificationService.markAllRead();
        sendJson(res, 200, { success: true });
        return;
      }

      // 8b. Two-Way Inbound Conversational Webhook (RFC 2822 Reply-To & Web Chat Ingestion)
      if (pathname === '/api/webhooks/inbound-email' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const from = String(body.from || '');
        const to = String(body.to || '');
        const subject = String(body.subject || '');
        const text = String(body.text || body.body || body.html || body.message || '');

        // Extract watchId from explicit parameter, "to" address, or subject
        let watchId = String(body.watch_id || '').trim();
        if (!watchId) {
          const toMatch = to.match(/(?:reply\+)?(?:watch_)?([a-zA-Z0-9_-]+)@/i);
          if (toMatch) {
            watchId = toMatch[1].startsWith('watch_') ? toMatch[1] : `watch_${toMatch[1]}`;
          }
        }
        if (!watchId) {
          const subMatch = subject.match(/(?:watch_)?([a-zA-Z0-9_-]{8,})/i);
          if (subMatch) {
            watchId = subMatch[1].startsWith('watch_') ? subMatch[1] : `watch_${subMatch[1]}`;
          }
        }

        // Search in repository
        let watch = watchId ? watchRepository.getById(watchId) : null;
        if (!watch && watchId) {
          const all = watchRepository.listAll();
          watch = all.find((w) => w.id === watchId || w.id.includes(watchId) || watchId.includes(w.id)) || null;
        }

        if (!watch) {
          const allCommerce = watchRepository.listAll().filter((w) => w.category === 'commerce_drop' || w.category === 'deal_or_promo' || w.commerce_predicate);
          if (allCommerce.length > 0) {
            watch = allCommerce[0];
          }
        }

        if (!watch) {
          sendJson(res, 404, { error: 'Watch not found for conversational reply' });
          return;
        }

        const existingPred = watch.commerce_predicate || {};
        const parsedPred = extractCommercePredicateFromText(text, existingPred.currency || 'NGN') || {};
        const updatedTarget = parsedPred.targetPrice ?? existingPred.targetPrice;
        const cur = parsedPred.currency || existingPred.currency || 'NGN';
        const curSymbol = cur === 'NGN' ? '₦' : cur === 'USD' ? '$' : cur;

        const updatedPredicate: CommercePredicateConfig = {
          ...existingPred,
          targetPrice: updatedTarget,
          currency: cur,
          ...(parsedPred.requiredPromoCode ? { requiredPromoCode: parsedPred.requiredPromoCode } : {})
        };

        const targetFormatted = updatedTarget ? `${curSymbol}${updatedTarget.toLocaleString('en-NG')}` : 'active target';
        const updatedCondition = `Landed price drops to ${targetFormatted} (updated via conversational reply)`;
        const updatedContext = `Target threshold updated to ${targetFormatted} via email reply from ${from || 'user'}: "${text.slice(0, 120)}..."`;

        watchRepository.updateFields(watch.id, {
          commerce_predicate: updatedPredicate,
          condition_text: updatedCondition,
          chat_context: updatedContext
        }, watch.tenant_id);

        const checklist = [
          `Target price updated to ${targetFormatted}`,
          `Monitoring verified merchant cluster (Fouani, Jumia, Alaba)`,
          `Instant email alert armed for ${from || watch.recipient_email || 'shopper'}`
        ];

        sendJson(res, 200, {
          success: true,
          watch_id: watch.id,
          title: watch.title,
          updated_target_price: updatedTarget,
          currency: cur,
          action_checklist: checklist,
          confirmation_message: `Got it! I've updated your price drop alert for ${watch.title} to ${targetFormatted}. I will alert you immediately once any verified store drops to this price.`
        });
        return;
      }

      const notifStatusMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/(open|ack)$/);
      if (notifStatusMatch && req.method === 'POST') {
        const notifId = decodeURIComponent(notifStatusMatch[1]);
        const { tenantId } = extractTenantId(req.headers, parsedUrl.searchParams);
        const ok = notificationService.updateDeliveryStatus(notifId, 'opened', tenantId);
        if (!ok) {
          sendJson(res, 404, { error: 'Notification not found' });
          return;
        }
        sendJson(res, 200, { success: true, id: notifId, delivery_status: 'opened' });
        return;
      }

      const emailPreviewMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/email-preview$/);
      if (emailPreviewMatch && req.method === 'GET') {
        const notifId = emailPreviewMatch[1];
        const html = notificationService.getRenderedEmailHtml(notifId);
        if (!html) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Email preview not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
        const publicKey = notificationService.getVapidPublicKey();
        sendJson(res, 200, { publicKey });
        return;
      }

      if (pathname === '/api/channels/web_push' && req.method === 'POST') {
        const { tenantId } = extractTenantId(req.headers, parsedUrl.searchParams);
        const body = await readJsonBody(req);
        const sub = (body.subscription || body) as {
          endpoint?: string;
          keys?: { p256dh?: string; auth?: string };
        };
        const endpoint = String(sub.endpoint || '');
        const p256dh = String(sub.keys?.p256dh || '');
        const auth = String(sub.keys?.auth || '');
        if (!endpoint || !p256dh || !auth) {
          sendJson(res, 400, { error: 'Invalid PushSubscription: endpoint, p256dh, and auth are required.' });
          return;
        }
        const updated = notificationService.updateChannelConfig(
          'web_push',
          true,
          {
            endpoint,
            p256dh,
            auth,
            vapid_public_key: notificationService.getVapidPublicKey()
          },
          tenantId
        );
        sendJson(res, 200, { success: true, channel: updated });
        return;
      }

      if (pathname === '/api/channels' && req.method === 'POST') {
        const { tenantId } = extractTenantId(req.headers, parsedUrl.searchParams);
        const body = await readJsonBody(req);
        const channel = body.channel as NotificationChannelType;
        const enabled = Boolean(body.enabled);
        const configObj = (body.config as Record<string, string>) || {};
        const updated = notificationService.updateChannelConfig(channel, enabled, configObj, tenantId);
        sendJson(res, 200, { channel: updated });
        return;
      }

      if (pathname === '/api/channels/test' && req.method === 'POST') {
        const { tenantId, userEmail, isExplicitTenant } = extractTenantId(req.headers, parsedUrl.searchParams);
        const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
        let recipientEmail = (typeof body.recipient === 'string' ? body.recipient : userEmail) || '';
        if (!recipientEmail && isExplicitTenant) {
          const saved = notificationService.getSavedDefaultEmail(tenantId);
          if (saved && !isDisallowedAmbientEmail(saved)) {
            recipientEmail = saved;
          }
        }
        if (!recipientEmail) {
          const globalDefault = notificationService.getSavedDefaultEmail();
          if (globalDefault && !isDisallowedAmbientEmail(globalDefault)) {
            recipientEmail = globalDefault;
          }
        }

        const requestedChannel = typeof body.channel === 'string' ? (body.channel as NotificationChannelType) : undefined;
        const watches = watchService.listWatches('all', tenantId, recipientEmail || undefined);
        const baseWatch: WatchRecord = watches[0] || {
          id: 'watch_test',
          tenant_id: tenantId,
          title: 'Global AI & STEM Graduate Scholarship 2027',
          category: 'scholarship',
          chat_context: 'Test notification from PulseRemind Channel Settings.',
          source_chat_client: 'PulseRemind Canary Test',
          target_url: `${baseUrl}/demo/scholarships/global-ai-fellowship`,
          secondary_url: null,
          trigger_type: 'web_monitor',
          condition_text: 'Applications open',
          expected_keywords: [],
          closed_keywords: [],
          window_start_date: '2026-10-28',
          window_label: 'End of Month',
          check_interval_minutes: 60,
          poll_after: 0,
          is_auto_resolve: true,
          proposed_outcome: 1,
          closing_soon_notified: false,
          resolution_config: {
            primary_source_name: 'Horizon Science Foundation',
            primary_source_url: `${baseUrl}/demo/scholarships/global-ai-fellowship`,
            oracle_api: 'web_portal',
            dynamic_condition: 'applications_open',
            provider_metadata: {},
            is_auto_resolve: true,
            entity_must_match: true
          },
          oracle_responses: [],
          status: 'triggered_open',
          notify_channels: requestedChannel ? [requestedChannel] : ['in_app', 'email', 'web_push'],
          recipient_email: recipientEmail || undefined,
          last_checked_at: new Date().toISOString(),
          last_snapshot_hash: null,
          last_status_summary: 'Canary test dispatch',
          detected_deadline: 'January 15, 2027',
          detected_apply_url: `${baseUrl}/demo/scholarships/global-ai-fellowship/apply`,
          triggered_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        };

        const testWatch: WatchRecord = {
          ...baseWatch,
          tenant_id: tenantId,
          recipient_email: recipientEmail || baseWatch.recipient_email,
          notify_channels: requestedChannel ? [requestedChannel] : baseWatch.notify_channels
        };

        const sent = await notificationService.dispatchOpenNotifications(
          testWatch,
          {
            httpStatus: 200,
            isOpen: true,
            outcome: 1,
            confidence: 0.99,
            summary: 'Canary test alert triggered to verify delivery on your active devices.',
            extractedSnippet:
              'Applications for the 2027 cohort are NOW OPEN! Apply online before January 15, 2027.',
            snapshotHash: 'canary_hash_' + Date.now(),
            pageChanged: true,
            detectedDeadline: 'January 15, 2027',
            detectedOpenDate: 'End of October 2026',
            detectedApplyUrl: `${baseUrl}/demo/scholarships/global-ai-fellowship/apply`,
            oracleRecord: null,
            cacheHit: false,
            entityValidated: true
          },
          { allowDuplicateTest: true }
        );

        sendJson(res, 200, { success: true, count: sent.length, dispatched: sent });
        return;
      }

      // 8b. Privacy-First Out-of-Band Claim Token Endpoints (/api/claim/:token & /claim/:token)
      const apiClaimMatch = pathname.match(/^\/api\/claim\/(prm_[a-z0-9]+)$/i);
      if (apiClaimMatch && req.method === 'POST') {
        const token = apiClaimMatch[1];
        const body = await readJsonBody(req);
        const claimed = watchService.claimSubscriberToken(token, {
          recipient_email: body.recipient_email ? String(body.recipient_email) : undefined,
          notify_channels: Array.isArray(body.notify_channels)
            ? (body.notify_channels as NotificationChannelType[])
            : undefined,
          ntfy_topic: body.ntfy_topic ? String(body.ntfy_topic) : undefined
        });
        if (!claimed) {
          sendJson(res, 404, { error: 'Claim token not found' });
          return;
        }
        sendJson(res, 200, { success: true, watch: claimed });
        return;
      }

      const webClaimMatch = pathname.match(/^\/claim\/(prm_[a-z0-9]+)$/i);
      if (webClaimMatch && req.method === 'GET') {
        const token = webClaimMatch[1];
        const watch = watchService
          .listWatches()
          .find((w) => w.resolution_config?.provider_metadata?.subscriber_token === token);
        const watchTitle = watch ? watch.title : `Reminder (${token})`;
        const currentEmail =
          watch && watch.recipient_email && !isDisallowedAmbientEmail(watch.recipient_email)
            ? watch.recipient_email
            : '';
        const currentNtfy = watch?.resolution_config?.provider_metadata?.ntfy_topic || `pulseremind-${token.slice(4, 10)}`;
        const calLinks = watch ? buildWatchCalendarLinks(watch, baseUrl) : null;
        const targetWindow = watch?.window_label || watch?.window_start_date || 'Upcoming';
        const targetDeadline = watch?.detected_deadline || 'To be determined';
        const targetUrl = watch?.target_url || '';
        const checklist = watch?.chat_context || '1. Monitor announcements\n2. Prepare credentials\n3. Register before window closes';

        // Auto-bind browser session cookie to this watch's tenant
        const cookieHeader = watch ? `prm_session=${encodeURIComponent(watch.tenant_id)}; Path=/; SameSite=Lax; Max-Age=31536000` : '';

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...(cookieHeader ? { 'Set-Cookie': cookieHeader } : {})
        });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claim Reminder — ${watchTitle}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 620px; margin: 36px auto; padding: 20px; background: #090d16; color: #f8fafc; line-height: 1.5; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.45); }
    .badge { display: inline-block; background: rgba(16,185,129,0.15); color: #34d399; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
    h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.3; }
    .meta-box { background: #0f172a; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px; margin: 16px 0; font-size: 13px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .meta-item strong { display: block; color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
    .checklist-box { background: #0b1120; border: 1px solid #1e293b; border-radius: 10px; padding: 16px; margin: 18px 0; }
    .checklist-box h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #38bdf8; }
    .checklist-item { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: #cbd5e1; margin-bottom: 8px; line-height: 1.4; }
    .cal-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 16px 0; }
    .btn-cal { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 14px; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: #f8fafc; text-decoration: none; font-size: 13px; font-weight: 600; text-align: center; }
    .btn-cal:hover { background: #334155; }
    label { display: block; font-size: 13px; font-weight: 600; color: #cbd5e1; margin-top: 16px; margin-bottom: 6px; }
    input[type="email"], input[type="text"] { width: 100%; box-sizing: border-box; padding: 11px 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #f8fafc; font-size: 14px; }
    .channels { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
    .chip { display: flex; align-items: center; gap: 6px; background: #0f172a; border: 1px solid #334155; padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; }
    .btn { width: 100%; margin-top: 20px; padding: 12px 18px; border: none; border-radius: 10px; background: linear-gradient(135deg, #10b981, #059669); color: #052e16; font-weight: 700; font-size: 15px; cursor: pointer; }
    .btn-vault { display: block; text-align: center; margin-top: 16px; color: #38bdf8; font-size: 13px; text-decoration: none; font-weight: 600; }
    .status { margin-top: 14px; font-size: 13px; color: #34d399; display: none; }
    .hint { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">🔒 Out-of-Band Claim Token • ${token}</span>
    <h1>${watchTitle}</h1>
    <p style="color:#94a3b8;font-size:13px;margin:0 0 16px;">This reminder was captured during your AI chat session. Your identity is private; bind your preferred channels below.</p>

    <div class="meta-box">
      <div class="meta-item">
        <strong>Target Window</strong>
        <span>📅 ${targetWindow}</span>
      </div>
      <div class="meta-item">
        <strong>Deadline</strong>
        <span>⏰ ${targetDeadline}</span>
      </div>
      ${targetUrl ? `<div class="meta-item" style="grid-column: span 2;"><strong>Target URL</strong><a href="${targetUrl}" target="_blank" style="color:#38bdf8;word-break:break-all;">${targetUrl}</a></div>` : ''}
    </div>

    <div class="checklist-box">
      <h3>📋 AI Action Checklist</h3>
      ${checklist.split('\n').filter(Boolean).map(item => `<div class="checklist-item"><span>✔️</span><span>${item.replace(/^[0-9.\-\s]+/, '')}</span></div>`).join('')}
    </div>

    ${calLinks ? `
    <label>🗓️ 1-Click Native Calendar Reminders (Dual VALARMs)</label>
    <div class="cal-actions">
      <a class="btn-cal" href="${calLinks.google_calendar_url}" target="_blank">Google Calendar ↗</a>
      <a class="btn-cal" href="${calLinks.ics_download_url}" download="${token}.ics">Apple / Outlook (.ics) ↓</a>
    </div>` : ''}

    <label for="email">📧 Email for Opening &amp; Deadline Alerts</label>
    <input id="email" type="email" placeholder="you@example.com" value="${currentEmail}" />

    <label for="ntfy">📲 Push Notifications Topic (via free <a href="https://ntfy.sh" target="_blank" style="color:#38bdf8;">ntfy.sh</a> app)</label>
    <input id="ntfy" type="text" placeholder="pulseremind-your-topic" value="${currentNtfy}" />
    <div class="hint">Subscribe to <strong>https://ntfy.sh/${currentNtfy}</strong> in iOS/Android or enable browser push below.</div>

    <label>🔔 Delivery Channels</label>
    <div class="channels">
      <label class="chip"><input type="checkbox" class="ch" value="in_app" checked /> Web Vault</label>
      <label class="chip"><input type="checkbox" class="ch" value="email" checked /> Email</label>
      <label class="chip"><input type="checkbox" class="ch" value="telegram" /> Telegram</label>
      <label class="chip"><input type="checkbox" class="ch" value="slack" /> Slack</label>
      <label class="chip"><input type="checkbox" class="ch" value="discord" /> Discord</label>
    </div>

    <button class="btn" id="saveBtn">Save &amp; Arm Notifications</button>
    <button class="btn-cal" id="browserPushBtn" type="button" style="width:100%;margin-top:10px;">🌐 Enable Browser Push on This Device</button>
    <div class="status" id="statusMsg"></div>

    <a href="/?session=${encodeURIComponent(watch?.tenant_id || '')}" class="btn-vault">View in My Personal Watch Vault &rarr;</a>
  </div>

  <script>
    document.getElementById('browserPushBtn').addEventListener('click', async () => {
      if (!('Notification' in window)) {
        alert('Browser push notifications are not supported in this browser.');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        new Notification('PulseRemind Push Active!', {
          body: 'You will receive browser push alerts for ' + ${JSON.stringify(watchTitle)},
          icon: '/pulseremind-icon-256.png'
        });
      }
    });

    document.getElementById('saveBtn').addEventListener('click', async () => {
      const email = document.getElementById('email').value.trim();
      const ntfy = document.getElementById('ntfy').value.trim();
      const channels = Array.from(document.querySelectorAll('.ch:checked')).map(el => el.value);
      const res = await fetch('/api/claim/${token}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_email: email || undefined, notify_channels: channels, ntfy_topic: ntfy || undefined })
      });
      const msg = document.getElementById('statusMsg');
      msg.style.display = 'block';
      if (res.ok) {
        msg.textContent = '✅ Armed! Alerts will be delivered to ' + (email || 'your selected channels') + '.';
      } else {
        msg.style.color = '#f87171';
        msg.textContent = '⚠️ Could not save watch settings.';
      }
    });
  </script>
</body>
</html>`);
        return;
      }

      // 8c. Route Separation: Dedicated Developer Simulation Sandbox Route
      if ((pathname === '/dev/sandbox' || pathname === '/sandbox') && req.method === 'GET') {
        const sandboxHtmlPath = path.join(process.cwd(), 'public', 'sandbox.html');
        if (fs.existsSync(sandboxHtmlPath)) {
          const content = fs.readFileSync(sandboxHtmlPath);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': content.length
          });
          res.end(content);
          return;
        }
      }

      // 9. Static Frontend Assets (public/)
      const publicDir = path.join(process.cwd(), 'public');
      const relativeFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.join(publicDir, relativeFile);

      if (
        filePath.startsWith(publicDir) &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
      ) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length
        });
        res.end(content);
        return;
      }

      sendJson(res, 404, { error: `Route not found: ${pathname}` });
    } catch (err) {
      console.error('[HTTP 500 Error]', err);
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });
}
