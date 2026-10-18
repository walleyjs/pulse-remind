import { chatExtractorService } from '../../internal/extractor/service.ts';
import { resolveTimeframeWindow } from '../../internal/extractor/timeframe.ts';
import { resolutionEngine } from '../../internal/resolution/engine.ts';
import type { NotificationChannelType } from '../../internal/watch/model.ts';
import { watchService } from '../../internal/watch/service.ts';

export interface McpToolDefinition {
  name: string;
  description: string;
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
      'Use this tool during an AI chat when the user is planning for something that is not open yet (e.g., scholarships, university admissions, fellowships, grants) opening at the end of the month or early next year. PRIVACY & DATA MINIMIZATION RULE: Never pass the user\'s raw personal data (full name, GPA, financial details, ID numbers, or full essay drafts). Only pass the public opportunity title, target URL, timeframe, and a short non-PII action checklist (e.g., "Prepare 2-page research proposal & 2 reference letters").',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Name of the public scholarship, grant, or opportunity (e.g., "Global AI Graduate Scholarship 2027")'
        },
        chat_context: {
          type: 'string',
          description: 'Short, non-PII action reminder of what the user needs to prepare when it opens (e.g., "Submit 2-page research proposal and 2 academic references"). Do NOT include personal identity or sensitive chat history.'
        },
        target_url: {
          type: 'string',
          description: 'URL of the scholarship or application page to monitor for opening'
        },
        timeframe_text: {
          type: 'string',
          description: 'When it is expected to open (e.g., "end of this month", "early next year", "January 2027")'
        },
        condition_text: {
          type: 'string',
          description: 'Specific condition to detect on the page (e.g., "Applications open for 2027 intake")'
        },
        recipient_email: {
          type: 'string',
          description: 'Optional email address to notify when open. If omitted, a private 1-click claim_url is returned so the user can bind their notification channel outside the chat.'
        },
        notify_channels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['in_app', 'email', 'slack', 'discord', 'telegram', 'whatsapp']
          },
          description: 'Notification channels to alert when open'
        }
      },
      required: ['title', 'chat_context']
    }
  },
  {
    name: 'extract_watches_from_chat',
    description:
      'Analyzes a raw AI conversation snippet where a user discusses future scholarships, school applications, or deadlines, automatically extracts all deferred opportunities, and optionally registers watches for them.',
    inputSchema: {
      type: 'object',
      properties: {
        transcript: {
          type: 'string',
          description: 'Conversation messages between the user and the AI assistant'
        },
        auto_create: {
          type: 'boolean',
          description: 'If true, automatically creates active watches for every extracted opportunity'
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
    description: 'Lists all scholarships, applications, and web-monitored reminders tracked for the user.',
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
      'Immediately fetches the target webpage of a tracked watch via the Resolution Engine, evaluates whether applications have opened, and dispatches notifications if open.',
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
    description: 'Updates the target URL, status, or notification settings of an existing watch, or deletes it.',
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
      const title = String(args.title || 'Untitled Opportunity Watch');
      const chatContext = String(args.chat_context || 'Created via AI chat tool.');
      const timeframeText = String(args.timeframe_text || args.condition_text || 'end of month');
      const windowInfo = resolveTimeframeWindow(timeframeText);

      const watch = watchService.createWatch({
        title,
        chat_context: chatContext,
        source_chat_client: String(args.source_chat_client || 'MCP AI Assistant'),
        target_url: args.target_url ? String(args.target_url) : `${baseUrl}/demo/scholarships/global-ai-fellowship`,
        condition_text: args.condition_text
          ? String(args.condition_text)
          : `Notify when ${title} opens (${windowInfo.window_label})`,
        window_start_date: windowInfo.window_start_date,
        window_label: windowInfo.window_label,
        notify_channels: Array.isArray(args.notify_channels)
          ? (args.notify_channels as NotificationChannelType[])
          : ['in_app', 'email'],
        recipient_email: args.recipient_email ? String(args.recipient_email) : 'student@university.edu'
      });

      return {
        success: true,
        message: `Watch created for "${watch.title}" (Window: ${watch.window_label}). We will monitor ${watch.target_url} and notify via [${watch.notify_channels.join(', ')}] as soon as it opens.`,
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
