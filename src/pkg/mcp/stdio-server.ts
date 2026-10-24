import readline from 'node:readline';
import { initDatabase } from '../db/bootstrap.ts';
import { executeMcpTool, MCP_TOOLS } from './tools.ts';
import { watchService } from '../../internal/watch/service.ts';
import { DEFAULT_TENANT_ID } from '../tenant/tenant.ts';

export function startMcpStdioServer(): void {
  initDatabase(true);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  function sendJsonRpcResponse(
    id: string | number | null,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown }
  ) {
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      id
    };
    if (error) {
      payload.error = error;
    } else {
      payload.result = result;
    }
    process.stdout.write(JSON.stringify(payload) + '\n');
  }

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: { id?: string | number | null; jsonrpc?: string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(trimmed);
    } catch {
      sendJsonRpcResponse(null, undefined, { code: -32700, message: 'Parse error' });
      return;
    }

    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      sendJsonRpcResponse(req?.id ?? null, undefined, {
        code: -32600,
        message: 'Invalid Request',
        data: 'Expected JSON-RPC 2.0 object with method string'
      });
      return;
    }

    const { id = null, method, params = {} } = req;

    try {
      if (method === 'initialize') {
        const requestedProtocol =
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
        sendJsonRpcResponse(id, {
          protocolVersion: requestedProtocol,
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true }
          },
          serverInfo: {
            name: 'pulseremind-mcp-server',
            version: '1.0.0'
          }
        });
        return;
      }

      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        return;
      }

      if (method === 'ping') {
        sendJsonRpcResponse(id, {});
        return;
      }

      if (method === 'tools/list') {
        sendJsonRpcResponse(id, {
          tools: MCP_TOOLS
        });
        return;
      }

      if (method === 'tools/call') {
        const toolName = typeof params.name === 'string' ? params.name.trim() : '';
        if (!toolName) {
          sendJsonRpcResponse(id, undefined, {
            code: -32602,
            message: 'Invalid params: tool name is required'
          });
          return;
        }
        if (!MCP_TOOLS.some((t) => t.name === toolName)) {
          sendJsonRpcResponse(id, undefined, {
            code: -32601,
            message: `Tool not found: ${toolName}`
          });
          return;
        }

        const toolArgs = (params.arguments as Record<string, unknown>) || {};
        const output = await executeMcpTool(toolName, toolArgs, 'http://localhost:3456', null, DEFAULT_TENANT_ID);
        sendJsonRpcResponse(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2)
            }
          ],
          structured: output
        });
        return;
      }

      if (method === 'resources/list') {
        const watches = watchService.listWatches('all', DEFAULT_TENANT_ID);
        sendJsonRpcResponse(id, {
          resources: [
            {
              uri: 'pulseremind://watches',
              name: 'Active Watches Collection',
              description: 'All monitored event watches',
              mimeType: 'application/json'
            },
            ...watches.map((w) => ({
              uri: `pulseremind://watches/${w.id}`,
              name: w.title,
              description: `Status: ${w.status} | Trigger: ${w.trigger_type} | Deadline: ${w.detected_deadline || 'none'}`,
              mimeType: 'application/json'
            }))
          ]
        });
        return;
      }

      if (method === 'resources/read') {
        const uri = typeof params.uri === 'string' ? params.uri.trim() : '';
        if (!uri) {
          sendJsonRpcResponse(id, undefined, { code: -32602, message: 'Invalid params: uri is required' });
          return;
        }
        if (uri === 'pulseremind://watches') {
          const watches = watchService.listWatches('all', DEFAULT_TENANT_ID);
          sendJsonRpcResponse(id, {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(watches, null, 2) }]
          });
          return;
        }
        if (uri.startsWith('pulseremind://watches/')) {
          const watchId = uri.replace('pulseremind://watches/', '').trim();
          const watch = watchService.getWatchById(watchId, DEFAULT_TENANT_ID);
          if (!watch) {
            sendJsonRpcResponse(id, undefined, { code: -32602, message: `Resource not found: ${uri}` });
            return;
          }
          const checkLogs = watchService.listCheckLogs(watch.id, 10, DEFAULT_TENANT_ID);
          sendJsonRpcResponse(id, {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ watch, recent_check_logs: checkLogs }, null, 2)
              }
            ]
          });
          return;
        }
        sendJsonRpcResponse(id, undefined, { code: -32602, message: `Unsupported resource URI: ${uri}` });
        return;
      }

      if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
        sendJsonRpcResponse(id, {});
        return;
      }

      sendJsonRpcResponse(id, undefined, {
        code: -32601,
        message: `Method not found: ${method}`
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJsonRpcResponse(id, undefined, {
        code: msg.toLowerCase().includes('missing required') ? -32602 : -32603,
        message: msg
      });
    }
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startMcpStdioServer();
}
