import { chatExtractorService, inferCategoryFromText } from '../../internal/extractor/service.ts';
import { resolveTimeframeWindow } from '../../internal/extractor/timeframe.ts';
import { resolutionEngine } from '../../internal/resolution/engine.ts';
import type { NotificationChannelType, TriggerType } from '../../internal/watch/model.ts';
import { watchService } from '../../internal/watch/service.ts';

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  annotations?: McpToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'create_opportunity_watch',
    description:
      'Use this tool during an AI chat whenever the user wants a reminder for ANY future event, registration, ticket sale, product launch, conference, deadline, fellowship, scholarship, or plan that is not open or due yet (e.g., happening at the end of the month, next month, or early next year). Supports both scheduled-date reminders and live web-page monitoring. PRIVACY & DATA MINIMIZATION RULE: Never pass the user\'s raw personal data (full name, ID numbers, financial details, or full chat logs). Only pass the event/opportunity title, optional target URL, timeframe, and a short non-PII action checklist.',
    annotations: {
      title: 'Create Event or Opportunity Reminder Watch',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Name of the event, reminder, conference, ticket drop, launch, or opportunity (e.g., "Apple WWDC 2027 Registration", "Coachella Ticket Presale", "Global AI Fellowship 2027")'
        },
        category: {
          type: 'string',
          enum: ['general_reminder', 'event', 'ticket_drop', 'product_launch', 'grant', 'scholarship'],
          description: 'Category of the event or reminder'
        },
        trigger_type: {
          type: 'string',
          enum: ['web_monitor', 'scheduled_date', 'hybrid'],
          description:
            'Use "scheduled_date" for pure date/time event reminders without a webpage, or "web_monitor" / "hybrid" to monitor a webpage until registration/applications open.'
        },
        chat_context: {
          type: 'string',
          description:
            'Short, non-PII action reminder of what the user planned or needs to do when the event arrives/opens (e.g., "Book early-bird pass and reserve hotel" or "Submit 2-page proposal"). Do NOT include personal identity or sensitive chat history.'
        },
        target_url: {
          type: 'string',
          description: 'Optional URL of the event, ticket, or application page to monitor for opening'
        },
        timeframe_text: {
          type: 'string',
          description: 'When the event or opening is expected (e.g., "end of this month", "next Friday", "early next year", "January 2027")'
        },
        condition_text: {
          type: 'string',
          description: 'Specific condition to detect or trigger on (e.g., "Registration opens", "Tickets go on sale", "Applications open")'
        },
        recipient_email: {
          type: 'string',
          description:
            'Optional email address to notify when triggered. If omitted, a private 1-click claim_url is returned so the user can bind their notification channel outside the chat.'
        },
        notify_channels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['in_app', 'email', 'slack', 'discord', 'telegram', 'whatsapp']
          },
          description: 'Notification channels to alert when triggered'
        }
      },
      required: ['title', 'chat_context']
    }
  },
  {
    name: 'extract_watches_from_chat',
    description:
      'Analyzes a conversation snippet where a user discusses future events, conferences, ticket sales, launches, deadlines, or scholarships, automatically extracts all deferred plans, and schedules reminders/watches for them.',
    annotations: {
      title: 'Extract Event & Opportunity Reminders From Chat',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        transcript: {
          type: 'string',
          description: 'Conversation messages between the user and the AI assistant'
        },
        auto_create: {
          type: 'boolean',
          description: 'If true, automatically creates active watches/reminders for every extracted event or opportunity'
        },
        recipient_email: {
          type: 'string',
          description: 'Optional user email for notifications'
        }
      },
      required: ['transcript']
    }
  },
  {
    name: 'list_active_watches',
    description: 'Lists all upcoming event reminders, ticket/launch watches, and web-monitored opportunities tracked for the user.',
    annotations: {
      title: 'List Active Event Reminders & Watches',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'hibernating', 'active_monitoring', 'triggered_open', 'config_error', 'paused'],
          description: 'Optional status filter'
        }
      }
    }
  },
  {
    name: 'check_watch_now',
    description:
      'Immediately evaluates a tracked event reminder or scrapes its target webpage via the Resolution Engine to check if registration/tickets/applications are open, and dispatches notifications if triggered.',
    annotations: {
      title: 'Check Event Watch Now',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        watch_id: {
          type: 'string',
          description: 'ID of the watch to check (e.g., "watch_...")'
        }
      },
      required: ['watch_id']
    }
  },
  {
    name: 'update_or_cancel_watch',
    description: 'Updates the status, target URL, or notification settings of an existing event reminder/watch, or deletes it.',
    annotations: {
      title: 'Update or Cancel Event Watch',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        watch_id: {
          type: 'string',
          description: 'ID of the watch'
        },
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'delete'],
          description: 'Action to perform on the watch'
        }
      },
      required: ['watch_id', 'action']
    }
  }
];

export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  baseUrl = 'http://localhost:3456'
): Promise<unknown> {
  switch (name) {
    case 'create_opportunity_watch': {
      const title = String(args.title || 'Untitled Event Reminder');
      const chatContext = String(args.chat_context || 'Created via AI chat tool.');
      const timeframeText = String(args.timeframe_text || args.condition_text || 'end of month');
      const windowInfo = resolveTimeframeWindow(timeframeText);
      const triggerType = (args.trigger_type as TriggerType) || undefined;
      const category = args.category ? String(args.category) : inferCategoryFromText(`${title} ${chatContext}`);

      const targetUrl =
        args.target_url !== undefined
          ? args.target_url
            ? String(args.target_url)
            : null
          : triggerType === 'scheduled_date'
            ? null
            : `${baseUrl}/demo/scholarships/global-ai-fellowship`;

      const watch = watchService.createWatch({
        title,
        category,
        chat_context: chatContext,
        source_chat_client: String(args.source_chat_client || 'MCP AI Assistant'),
        target_url: targetUrl,
        trigger_type: triggerType,
        condition_text: args.condition_text
          ? String(args.condition_text)
          : `Notify when ${title} opens or arrives (${windowInfo.window_label})`,
        window_start_date: windowInfo.window_start_date,
        window_label: windowInfo.window_label,
        notify_channels: Array.isArray(args.notify_channels)
          ? (args.notify_channels as NotificationChannelType[])
          : ['in_app', 'email'],
        recipient_email: args.recipient_email ? String(args.recipient_email) : 'student@university.edu'
      });

      return {
        success: true,
        message: `Reminder watch created for "${watch.title}" (Window: ${watch.window_label}). ${
          watch.target_url ? `Monitoring ${watch.target_url}` : 'Scheduled for target date window'
        } and will notify via [${watch.notify_channels.join(', ')}] as soon as it triggers.`,
        claim_url: watch.resolution_config.provider_metadata.claim_url,
        subscriber_token: watch.resolution_config.provider_metadata.subscriber_token,
        watch
      };
    }

    case 'extract_watches_from_chat': {
      const transcript = String(args.transcript || '');
      const autoCreate = Boolean(args.auto_create ?? true);
      const extracted = chatExtractorService.extractWatchesFromTranscript(transcript, baseUrl);
      const createdWatches = [];

      if (autoCreate) {
        for (const item of extracted) {
          const input = chatExtractorService.toWatchInput(
            item,
            args.recipient_email ? String(args.recipient_email) : undefined
          );
          createdWatches.push(watchService.createWatch(input));
        }
      }

      return {
        success: true,
        extracted_count: extracted.length,
        extracted_opportunities: extracted,
        created_watches: createdWatches
      };
    }

    case 'list_active_watches': {
      const status = args.status ? String(args.status) : 'all';
      const watches = watchService.listWatches(status);
      return {
        count: watches.length,
        watches
      };
    }

    case 'check_watch_now': {
      const watchId = String(args.watch_id || '');
      const outcome = await resolutionEngine.runWatchCheck(watchId);
      if (!outcome) {
        throw new Error(`Watch "${watchId}" not found.`);
      }
      return {
        success: true,
        is_open: outcome.evaluation.isOpen,
        newly_triggered: outcome.newlyTriggered,
        summary: outcome.evaluation.summary,
        detected_deadline: outcome.evaluation.detectedDeadline,
        detected_apply_url: outcome.evaluation.detectedApplyUrl,
        notifications_sent: outcome.notificationsDispatched.length,
        watch: outcome.watch
      };
    }

    case 'update_or_cancel_watch': {
      const watchId = String(args.watch_id || '');
      const action = String(args.action || '');
      if (action === 'delete') {
        const deleted = watchService.deleteWatch(watchId);
        return { success: deleted, watch_id: watchId, action: 'deleted' };
      }
      const existing = watchService.getWatchById(watchId);
      if (!existing) {
        throw new Error(`Watch "${watchId}" not found.`);
      }
      const nextStatus = action === 'pause' ? 'paused' : 'active_monitoring';
      const updated = watchService.updateWatchFields(watchId, { status: nextStatus });
      return { success: true, watch: updated };
    }

    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}
