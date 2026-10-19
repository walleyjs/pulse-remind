import { MCP_TOOLS } from '../mcp/tools.ts';

/**
 * Builds a complete OpenAPI 3.1.0 specification compatible with:
 * - ChatGPT Custom GPT Actions (includes `x-openai-isConsequential: false`, full `requestBody` & `components.schemas`)
 * - Google Gemini / Vertex AI Extensions
 */
export function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PulseRemind — AI Chat Opportunity Reminder & Web Monitor API',
      version: '1.0.0',
      description:
        'Privacy-first tool API for ChatGPT Actions and Google Gemini Extensions. Captures future-dated opportunities mentioned during AI chats (e.g., scholarships opening at the end of the month or early next year), monitors their web portals, and alerts users when applications open. Never pass raw user PII; only pass the public opportunity title, timeframe, and a short non-PII preparation checklist.'
    },
    servers: [{ url: baseUrl, description: 'PulseRemind API Server' }],
    paths: {
      '/api/watches': {
        get: {
          operationId: 'listActiveWatches',
          summary: 'List all tracked opportunity watches and reminders',
          'x-openai-isConsequential': false,
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: {
                type: 'string',
                enum: ['all', 'hibernating', 'active_monitoring', 'triggered_open', 'config_error', 'paused']
              },
              description: 'Optional status filter'
            }
          ],
          responses: {
            '200': {
              description: 'List of tracked opportunity watches',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      watches: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/WatchRecord' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        post: {
          operationId: 'createOpportunityWatch',
          summary:
            'Create a web-monitored reminder when the user mentions a scholarship, admission, or grant that is not open yet',
          'x-openai-isConsequential': false,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateWatchRequest' }
              }
            }
          },
          responses: {
            '201': {
              description: 'Created watch with private 1-click claim_url',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      watch: { $ref: '#/components/schemas/WatchRecord' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/chat/extract': {
        post: {
          operationId: 'extractWatchesFromChat',
          summary:
            'Extract deferred opportunities and opening timeframes from a chat snippet and automatically schedule watches',
          'x-openai-isConsequential': false,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['transcript'],
                  properties: {
                    transcript: {
                      type: 'string',
                      description:
                        'Sanitized conversation snippet where the user discusses scholarships or applications opening in the future'
                    },
                    auto_create: {
                      type: 'boolean',
                      default: true,
                      description: 'Automatically create watches for extracted opportunities'
                    },
                    recipient_email: {
                      type: 'string',
                      description: 'Optional user email for notifications'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Extracted opportunities and created watches'
            }
          }
        }
      },
      '/api/watches/{id}/check': {
        post: {
          operationId: 'checkWatchNow',
          summary: 'Immediately scrape and evaluate the target URL for a watch via the Resolution Engine',
          'x-openai-isConsequential': false,
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Watch ID (e.g., watch_...)'
            }
          ],
          responses: {
            '200': { description: 'Check outcome and dispatched notifications' }
          }
        }
      }
    },
    components: {
      schemas: {
        CreateWatchRequest: {
          type: 'object',
          required: ['title', 'chat_context'],
          properties: {
            title: {
              type: 'string',
              description: 'Name of the public scholarship, fellowship, or opportunity'
            },
            chat_context: {
              type: 'string',
              description:
                'Short, non-PII action checklist of what the user needs to prepare (e.g., "Prepare 2-page research proposal and request 2 academic references"). Never include personal identity or sensitive chat history.'
            },
            target_url: {
              type: 'string',
              description: 'Optional URL of the scholarship portal to monitor'
            },
            timeframe_text: {
              type: 'string',
              description: 'Expected opening window (e.g., "end of this month", "early next year")'
            },
            condition_text: {
              type: 'string',
              description: 'Condition to detect on the page'
            },
            recipient_email: {
              type: 'string',
              description:
                'Optional email address. If omitted, present the returned claim_url to the user so they can bind their notification channel privately outside the chat.'
            },
            notify_channels: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['in_app', 'email', 'slack', 'discord', 'telegram', 'whatsapp']
              }
            }
          }
        },
        WatchRecord: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            target_url: { type: 'string', nullable: true },
            window_label: { type: 'string', nullable: true },
            window_start_date: { type: 'string', nullable: true },
            chat_context: { type: 'string' },
            resolution_config: {
              type: 'object',
              properties: {
                provider_metadata: {
                  type: 'object',
                  properties: {
                    subscriber_token: { type: 'string' },
                    claim_url: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

/**
 * Builds native Google Gemini `functionDeclarations` + System Instruction
 * for Google AI Studio, Gemini API (`tools: [{ functionDeclarations }]`), and Vertex AI Extensions.
 */
export function buildGeminiToolsManifest(baseUrl: string): Record<string, unknown> {
  return {
    platform: 'google-gemini',
    endpoint: `${baseUrl}/mcp`,
    openapi_url: `${baseUrl}/api/openapi.json`,
    system_instruction:
      'Whenever the user mentions a scholarship, fellowship, admission, or grant that is not open yet (e.g. opening at the end of the month, next semester, or early next year), proactively call `create_opportunity_watch`. Do NOT ask the user for their personal details or email in chat; pass only a sanitized preparation checklist in `chat_context` and return the `claim_url` from the tool response so the user can bind their notification channel privately.',
    tools: [
      {
        functionDeclarations: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }))
      }
    ]
  };
}
