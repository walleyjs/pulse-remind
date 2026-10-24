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
      title: 'PulseRemind — AI Chat Event, Date & Web-State Reminder API',
      version: '1.0.0',
      description:
        'Declarative API for creating event watches, monitoring webpage status, and dispatching multi-channel notifications for deadlines, ticket drops, and scheduled reminders.'
    },
    servers: [{ url: baseUrl, description: 'PulseRemind API Server' }],
    paths: {
      '/api/watches': {
        get: {
          operationId: 'listActiveWatches',
          summary: 'List tracked event watches and scheduled reminders',
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
              description: 'List of tracked event watches and reminders',
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
          summary: 'Create a monitored watch or scheduled reminder for an event or deadline',
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
          summary: 'Extract event details from text and provision watches',
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
                      description: 'Conversation text containing upcoming events, dates, or deadlines'
                    },
                    auto_create: {
                      type: 'boolean',
                      default: true,
                      description: 'Whether to automatically create watches for extracted events'
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
              description: 'Extracted events and created watches'
            }
          }
        }
      },
      '/api/watches/{id}/check': {
        post: {
          operationId: 'checkWatchNow',
          summary: 'Evaluate the current state of a specified watch',
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
              description: 'Name of the event, conference, ticket sale, product launch, registration, scholarship, or general reminder'
            },
            category: {
              type: 'string',
              enum: [
                'event',
                'conference',
                'tickets',
                'registration',
                'product_launch',
                'deadline',
                'reminder',
                'scholarship',
                'fellowship',
                'grant',
                'admission',
                'accelerator',
                'visa',
                'general'
              ],
              description: 'Category of reminder or event'
            },
            trigger_type: {
              type: 'string',
              enum: ['scheduled_date', 'web_monitor', 'hybrid'],
              description:
                'How the reminder triggers: "scheduled_date" (fires when the date/time arrives, no URL required), "web_monitor" (scrapes target_url), or "hybrid"'
            },
            chat_context: {
              type: 'string',
              description:
                'Short, non-PII action checklist of what the user wants to remember or prepare (e.g., "Buy early-bird ticket; book hotel near Moscone Center; submit speaker abstract"). Never include personal identity or sensitive chat history.'
            },
            target_url: {
              type: 'string',
              description: 'Optional URL of the event page, ticket portal, or registration site to monitor. Omit for pure date reminders.'
            },
            timeframe_text: {
              type: 'string',
              description: 'Natural language date or timeframe (e.g., "end of this month", "next Friday", "in 2 weeks", "early next year", or ISO date)'
            },
            condition_text: {
              type: 'string',
              description: 'Condition to trigger on (e.g., "Registration or ticket sales open", "Scheduled reminder date reached")'
            },
            recipient_email: {
              type: 'string',
              description: 'Optional recipient email address for notifications'
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
            category: { type: 'string' },
            trigger_type: { type: 'string' },
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
      'Provides tools to create event watches, monitor registration portals and deadlines, and provision reminder notifications.',
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
