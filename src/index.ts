import { config } from './config/index.ts';
import { createAppServer } from './pkg/server/http-server.ts';
import { resolutionEngine } from './internal/resolution/engine.ts';
import { cloudDatabaseSync } from './pkg/db/cloud-sync.ts';

export { createAppServer, resolutionEngine };

// Start server if invoked directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = createAppServer();
  server.listen(config.port, () => {
    console.log(`🚀 PulseRemind AI Chat Reminder & Web Monitor running at http://localhost:${config.port}`);
    console.log(`🔌 MCP JSON-RPC HTTP Endpoint: http://localhost:${config.port}/mcp`);
    console.log(`📄 OpenAPI Tool Spec:          http://localhost:${config.port}/api/openapi.json`);
    cloudDatabaseSync.syncBidirectional().catch(() => {});
    resolutionEngine.startScheduler();
  });
}
