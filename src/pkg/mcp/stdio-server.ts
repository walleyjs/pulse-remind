import readline from 'node:readline';
import { initDatabase } from '../db/bootstrap.ts';
import { executeMcpTool, MCP_TOOLS } from './tools.ts';

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
    error?: { code: number; message: string }
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

    let req: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(trimmed);
    } catch {
      sendJsonRpcResponse(null, undefined, { code: -32700, message: 'Parse error' });
      return;
    }

    const { id = null, method, params = {} } = req;

    try {
      if (method === 'initialize') {
        sendJsonRpcResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'pulseremind-mcp-server',
            version: '1.0.0'
          }
        });
        return;
      }

      if (method === 'notifications/initialized') {
        return;
      }

      if (method === 'tools/list') {
        sendJsonRpcResponse(id, {
          tools: MCP_TOOLS
        });
        return;
      }

      if (method === 'tools/call') {
        const toolName = String(params.name || '');
        const toolArgs = (params.arguments as Record<string, unknown>) || {};
        const output = await executeMcpTool(toolName, toolArgs);
        sendJsonRpcResponse(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2)
            }
          ]
        });
        return;
      }

      sendJsonRpcResponse(id, undefined, {
        code: -32601,
        message: `Method not found: ${method}`
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true
      });
    }
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startMcpStdioServer();
}
