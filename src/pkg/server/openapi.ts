export function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PulseRemind — AI Chat Opportunity Reminder & Web Monitor API',
      version: '1.0.0',
      description:
        'Clean Architecture Tool API & MCP service that captures future-dated opportunities from LLM chats (e.g., scholarships opening end of month or early next year), monitors their websites via an Octopus-style Resolution Engine, and notifies users when applications open.'
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/api/watches': {
        get: {
          operationId: 'listActiveWatches',
          summary: 'List all tracked opportunity watches and reminders',
          responses: { '200': { description: 'List of watches' } }
        },
        post: {
          operationId: 'createOpportunityWatch',
          summary: 'Create a new web-monitored reminder from an AI chat conversation',
          responses: { '201': { description: 'Created watch' } }
        }
      },
      '/api/chat/extract': {
        post: {
          operationId: 'extractWatchesFromChat',
          summary: 'Extract deferred opportunities and dates from an AI chat transcript and optionally schedule them',
          responses: { '200': { description: 'Extracted opportunities and created watches' } }
        }
      },
      '/api/watches/{id}/check': {
        post: {
          operationId: 'checkWatchNow',
          summary: 'Immediately scrape and evaluate the target URL for a watch via the Resolution Engine',
          responses: { '200': { description: 'Check outcome and dispatched notifications' } }
        }
      }
    }
  };
}
