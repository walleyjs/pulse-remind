import { config } from './config/index.ts';
import { createAppServer } from './pkg/server/http-server.ts';
import { resolutionEngine } from './internal/resolution/engine.ts';
import { cloudDatabaseSync } from './pkg/db/cloud-sync.ts';

export { createAppServer, resolutionEngine };

// Start server if invoked directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // Enforce: Database is strictly locked to Supabase in production/standalone mode
  if (config.cloud.storageProvider === 'supabase') {
    if (!config.cloud.supabaseUrl || !config.cloud.supabaseKey) {
      console.error('❌ FATAL: Database is strictly locked to Supabase. Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
      process.exit(1);
    }
  }

  const server = createAppServer();
  server.listen(config.port, async () => {
    console.log(`🚀 PulseRemind AI Chat Reminder & Web Monitor running at http://localhost:${config.port}`);
    console.log(`🔌 MCP JSON-RPC HTTP Endpoint: http://localhost:${config.port}/mcp`);
    console.log(`📄 OpenAPI Tool Spec:          http://localhost:${config.port}/api/openapi.json`);
    
    try {
      const syncResult = await cloudDatabaseSync.syncBidirectional();
      console.log(`📦 Supabase Synced: ${syncResult.pulledWatches} pulled, ${syncResult.pushedWatches} pushed.`);
    } catch (err) {
      console.error(`⚠️ Supabase initial sync warning:`, err);
    }

    resolutionEngine.startScheduler();
  });
}
