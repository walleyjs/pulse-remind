import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
import { executeMcpTool, MCP_TOOLS } from '../mcp/tools.ts';
import { buildGeminiToolsManifest, buildOpenApiSpec } from './openapi.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
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
  return JSON.parse(raw);
}

export function createAppServer(): http.Server {
  initDatabase(true);

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
        const metrics = await resolutionEngine.runCycleWithMetrics(forceAll);
        sendJson(res, 200, {
          status: 'awake_and_resolved',
          triggered_at: new Date().toISOString(),
          uptime_seconds: Math.floor(process.uptime()),
          infrastructure: cloudDatabaseSync.getStatus(),
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
        if (redirectUri) {
          const target = new URL(redirectUri);
          target.searchParams.set('code', 'prm_oauth_code_live');
          if (state) target.searchParams.set('state', state);
          res.writeHead(302, { Location: target.toString() });
          res.end();
          return;
        }
        sendJson(res, 200, { code: 'prm_oauth_code_live', state });
        return;
      }

      if (pathname === '/oauth/token' && req.method === 'POST') {
        sendJson(res, 200, {
          access_token: 'prm_live_access_token',
          token_type: 'Bearer',
          expires_in: 86400 * 30,
          refresh_token: 'prm_live_refresh_token',
          scope: 'mcp:tools'
        });
        return;
      }

      if ((pathname === '/plugin.json' || pathname === '/.well-known/mcp.json') && req.method === 'GET') {
        sendJson(res, 200, {
          name: 'pulseremind',
          version: '1.0.0',
          description:
            'Captures future-dated scholarships, fellowships, and admissions mentioned in AI chats, monitors their web pages, and notifies users when applications open.',
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
        const body = await readJsonBody(req);
        const id = (body.id as string | number | null) ?? null;
        const method = String(body.method || '');
        const params = (body.params as Record<string, unknown>) || {};

        if (method === 'initialize') {
          const requestedProtocol =
            typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: requestedProtocol,
              capabilities: { tools: { listChanged: false } },
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
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { resources: [] } });
          return;
        }
        if (method === 'prompts/list') {
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { prompts: [] } });
          return;
        }
        if (method === 'tools/call') {
          const toolName = String(params.name || '');
          const toolArgs = (params.arguments as Record<string, unknown>) || {};
          const output = await executeMcpTool(toolName, toolArgs, baseUrl);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structured: output
            }
          });
          return;
        }
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unsupported MCP method: ${method}` }
        });
        return;
      }

      // 4. Dashboard Overview & State API
      if (pathname === '/api/overview' && req.method === 'GET') {
        const watches = watchService.listWatches();
        const notifications = notificationService.listNotifications(40);
        const checkLogs = watchService.listCheckLogs(undefined, 25);
        const channels = notificationService.getChannelConfigs();
        const demoPortals = demoPortalService.listPortals();

        sendJson(res, 200, {
          infrastructure: cloudDatabaseSync.getStatus(),
          watches,
          notifications,
          unread_count: notifications.filter((n) => !n.is_read).length,
          check_logs: checkLogs,
          channels,
          demo_portals: demoPortals,
          mcp_tools: MCP_TOOLS
        });
        return;
      }

      // 5. Watches CRUD + Resolution Engine triggers
      if (pathname === '/api/watches' && req.method === 'GET') {
        const statusFilter = parsedUrl.searchParams.get('status') || 'all';
        sendJson(res, 200, { watches: watchService.listWatches(statusFilter) });
        return;
      }

      if (pathname === '/api/watches' && req.method === 'POST') {
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
          recipient_email: body.recipient_email
            ? String(body.recipient_email)
            : 'student@university.edu'
        });

        sendJson(res, 201, { watch });
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
        const recipientEmail = body.recipient_email
          ? String(body.recipient_email)
          : 'student@university.edu';

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
          recipient_email: 'student@university.edu',
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
            : undefined
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Claim PulseRemind Alert (${token})</title></head>
          <body style="font-family:sans-serif;max-width:560px;margin:48px auto;padding:24px;background:#090d16;color:#f1f5f9;">
            <h2>🔒 Bind Your Alert Destination (${token})</h2>
            <p style="color:#94a3b8;">Your AI chat never sees your contact details. Bind your preferred delivery channel directly to this anonymous watch token.</p>
          </body></html>`);
        return;
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
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      sendJson(res, 404, { error: `Route not found: ${pathname}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });
}
