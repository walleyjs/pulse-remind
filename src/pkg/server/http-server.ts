import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { config } from '../../config/index.ts';
import { demoPortalService } from '../../internal/demo/service.ts';
import { chatExtractorService } from '../../internal/extractor/service.ts';
import { resolveTimeframeWindow } from '../../internal/extractor/timeframe.ts';
import { notificationService } from '../../internal/notification/service.ts';
import { resolutionEngine } from '../../internal/resolution/engine.ts';
import type { NotificationChannelType, WatchRecord } from '../../internal/watch/model.ts';
import { watchService } from '../../internal/watch/service.ts';
import { initDatabase } from '../db/bootstrap.ts';
import { cloudDatabaseSync } from '../db/cloud-sync.ts';
import { outboxProcessor } from '../db/outbox.ts';
import { extractTenantId, createOAuthJwtToken } from '../tenant/tenant.ts';
import { buildWatchIcsFeed, buildWatchCalendarLinks } from '../calendar/ics.ts';
import { isDisallowedAmbientEmail } from '../privacy/minimizer.ts';
import { executeMcpTool, MCP_TOOLS } from '../mcp/tools.ts';
import { buildGeminiToolsManifest, buildOpenApiSpec } from './openapi.ts';

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

        // Multi-tenant privacy invariant: anonymous visitors receive an empty vault with zero private DB records
        const watches = isExplicitTenant ? watchService.listWatches('all', tenantId) : [];
        const notifications = isExplicitTenant ? notificationService.listNotifications(40, tenantId) : [];
        const checkLogs = isExplicitTenant ? watchService.listCheckLogs(undefined, 25, tenantId) : [];
        const channels = isExplicitTenant ? notificationService.getChannelConfigs(tenantId) : [];

        sendJson(res, 200, {
          authenticated: isExplicitTenant,
          auth_source: authSource,
          tenant_id: isExplicitTenant ? tenantId : null,
          user_email: userEmail,
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
        const requestedTenant = typeof body.tenant_id === 'string' && body.tenant_id.trim()
          ? body.tenant_id.trim()
          : (typeof body.email === 'string' && body.email.includes('@')
              ? 'tenant_' + crypto.createHash('sha256').update(body.email.trim()).digest('hex').slice(0, 16)
              : null);
        if (!requestedTenant) {
          sendJson(res, 400, { error: 'Invalid tenant_id or email provided' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `prm_session=${encodeURIComponent(requestedTenant)}; Path=/; SameSite=Lax; Max-Age=31536000`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, tenant_id: requestedTenant }));
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
        const { tenantId, isExplicitTenant } = extractTenantId(req.headers, parsedUrl.searchParams);
        const statusFilter = parsedUrl.searchParams.get('status') || 'all';
        const watches = isExplicitTenant ? watchService.listWatches(statusFilter, tenantId) : [];
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

        const watch = watchService.createWatch({
          title: String(body.title || 'New Opportunity Watch'),
          category: String(body.category || 'scholarship'),
          chat_context: String(body.chat_context || 'Planned during AI chat session.'),
          source_chat_client: String(body.source_chat_client || 'Web Dashboard / MCP'),
          target_url: body.target_url
            ? String(body.target_url)
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
            : undefined
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
        const outcome = await resolutionEngine.runWatchCheck(watchId);
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

      if (pathname === '/api/channels' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const channel = body.channel as NotificationChannelType;
        const enabled = Boolean(body.enabled);
        const configObj = (body.config as Record<string, string>) || {};
        const updated = notificationService.updateChannelConfig(channel, enabled, configObj);
        sendJson(res, 200, { channel: updated });
        return;
      }

      if (pathname === '/api/channels/test' && req.method === 'POST') {
        const watches = watchService.listWatches();
        const sampleWatch: WatchRecord = watches[0] || {
          id: 'watch_test',
          title: 'Global AI & STEM Graduate Scholarship 2027',
          category: 'scholarship',
          chat_context: 'Test notification from PulseRemind Channel Settings.',
          source_chat_client: 'PulseRemind Test',
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
          notify_channels: ['in_app', 'email'],
          recipient_email: notificationService.getSavedDefaultEmail(tenantId) || 'alerts@pulseremind.ai',
          last_checked_at: new Date().toISOString(),
          last_snapshot_hash: null,
          last_status_summary: 'Test dispatch',
          detected_deadline: 'January 15, 2027',
          detected_apply_url: `${baseUrl}/demo/scholarships/global-ai-fellowship/apply`,
          triggered_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        };

        const sent = await notificationService.dispatchOpenNotifications(
          sampleWatch,
          {
            httpStatus: 200,
            isOpen: true,
            outcome: 1,
            confidence: 0.99,
            summary: 'Test notification triggered manually from Channel Settings.',
            extractedSnippet:
              'Applications for the 2027 cohort are NOW OPEN! Apply online before January 15, 2027.',
            snapshotHash: 'test_hash',
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

        sendJson(res, 200, { dispatched: sent });
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
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });
}
