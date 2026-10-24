import { config } from '../../config/index.ts';
import { chatExtractorService, inferCategoryFromText } from '../../internal/extractor/service.ts';
import { notificationService } from '../../internal/notification/service.ts';
import { resolveTimeframeWindow } from '../../internal/extractor/timeframe.ts';
import { resolutionEngine } from '../../internal/resolution/engine.ts';
import type { NotificationChannelType, TriggerType } from '../../internal/watch/model.ts';
import { watchService } from '../../internal/watch/service.ts';
import { buildWatchCalendarLinks } from '../calendar/ics.ts';
import { DEFAULT_TENANT_ID } from '../tenant/tenant.ts';
import { isDisallowedAmbientEmail } from '../privacy/minimizer.ts';

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
      'Creates a monitored watch or scheduled reminder for an upcoming event, ticket release, product launch, conference, registration window, or deadline.',
    annotations: {
      title: 'Create Event Watch or Scheduled Reminder',
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
            'Name of the event, opportunity, or reminder (e.g., "Apple WWDC 2027 Registration", "Swedish Institute Scholarship 2027–2028")'
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
          description: 'Category of the event or reminder'
        },
        trigger_type: {
          type: 'string',
          enum: ['web_monitor', 'scheduled_date', 'hybrid'],
          description:
            'Trigger mechanism: scheduled_date for pure time reminders, web_monitor to check page status, or hybrid for both.'
        },
        chat_context: {
          type: 'string',
          description:
            'Action checklist or preparation notes for the event. Omit sensitive personal identity data.'
        },
        target_url: {
          type: 'string',
          description: 'Optional URL of the webpage or portal to monitor for status changes'
        },
        timeframe_text: {
          type: 'string',
          description:
            'Anticipated date, timeframe, or deadline expression (e.g., "end of month", "next Friday", "November 15, 2026 AoE")'
        },
        condition_text: {
          type: 'string',
          description:
            'Specific trigger condition to detect (e.g., "Registration opens", "Tickets go on sale")'
        },
        recipient_email: {
          type: 'string',
          description:
            'Optional destination email address for alert delivery.'
        },
        notify_channels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['in_app', 'email', 'web_push', 'slack', 'discord', 'telegram', 'whatsapp']
          },
          description: 'Notification channels to alert when triggered'
        }
      },
      required: ['title', 'chat_context']
    }
  },
  {
    name: 'set_notification_destination',
    description:
      'Configures destination email and push notification channels for monitored watches belonging to the active user.',
    annotations: {
      title: 'Configure Notification Destination',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        recipient_email: {
          type: 'string',
          description: 'Destination email address for notifications.'
        },
        watch_id: {
          type: 'string',
          description: 'Optional identifier of a specific watch to update. If omitted, applies to all active watches.'
        },
        save_as_default: {
          type: 'boolean',
          description: 'Whether to store this destination for future watches created in this session.'
        },
        ntfy_topic: {
          type: 'string',
          description: 'Optional mobile push topic name.'
        },
        notify_channels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['in_app', 'email', 'web_push', 'slack', 'discord', 'telegram', 'whatsapp']
          },
          description: 'Enabled notification channels.'
        }
      },
      required: ['recipient_email']
    }
  },
  {
    name: 'extract_watches_from_chat',
    description:
      'Extracts event entities, deadlines, and action checklists from conversation text and provisions corresponding reminder watches.',
    annotations: {
      title: 'Extract Event Watches From Chat',
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
          description: 'Conversation text containing upcoming events, dates, or deadlines.'
        },
        auto_create: {
          type: 'boolean',
          description: 'Whether to automatically provision watches for extracted items.'
        },
        recipient_email: {
          type: 'string',
          description: 'Optional user email address for notifications.'
        }
      },
      required: ['transcript']
    }
  },
  {
    name: 'list_active_watches',
    description: 'Lists tracked event reminders, ticket watches, and monitored opportunities for the active user.',
    annotations: {
      title: 'List Active Event Watches',
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
      'Evaluates the current state of a specified watch and dispatches notifications if state conditions are met.',
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
          description: 'Identifier of the watch to check.'
        }
      },
      required: ['watch_id']
    }
  },
  {
    name: 'update_or_cancel_watch',
    description: 'Updates the status (pause, resume, delete) or settings of an existing event watch.',
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
          description: 'Identifier of the watch.'
        },
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'delete'],
          description: 'Action to perform: pause, resume, or delete.'
        }
      },
      required: ['watch_id', 'action']
    }
  }
];

export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  baseUrl = config.cloud.renderExternalUrl || 'http://localhost:3456',
  oauthEmail?: string | null,
  tenantId = DEFAULT_TENANT_ID
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

      const providedEmail =
        args.recipient_email && !isDisallowedAmbientEmail(String(args.recipient_email))
          ? String(args.recipient_email).trim()
          : (oauthEmail && !isDisallowedAmbientEmail(oauthEmail) ? oauthEmail : undefined);

      if (providedEmail) {
        notificationService.setSavedDefaultEmail(providedEmail, tenantId);
      }

      const watch = watchService.createWatch({
        title,
        tenant_id: tenantId,
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
        recipient_email: providedEmail
      }, tenantId);

      const calendarLinks = buildWatchCalendarLinks(watch, baseUrl);
      const hasBoundEmail = Boolean(watch.recipient_email && !isDisallowedAmbientEmail(watch.recipient_email));

      return {
        success: true,
        watch_id: watch.id,
        status: 'created',
        delivery_status: hasBoundEmail ? 'BOUND_READY' : 'ACTION_REQUIRED_ASK_USER_FOR_EMAIL',
        destination_status: hasBoundEmail ? 'bound' : 'unbound',
        bound_email: hasBoundEmail ? watch.recipient_email : null,
        calendar_links: calendarLinks,
        message: `Reminder watch created for "${watch.title}" (Window: ${watch.window_label}).`,
        claim_url: watch.resolution_config.provider_metadata.claim_url,
        subscriber_token: watch.resolution_config.provider_metadata.subscriber_token,
        watch
      };
    }

    case 'set_notification_destination': {
      const recipientEmail = String(args.recipient_email || '').trim();
      if (!recipientEmail || !recipientEmail.includes('@') || isDisallowedAmbientEmail(recipientEmail)) {
        throw new Error('A valid, non-ambient recipient_email is required.');
      }
      const watchId = args.watch_id ? String(args.watch_id) : undefined;
      const saveAsDefault = args.save_as_default !== false;
      const ntfyTopic = args.ntfy_topic ? String(args.ntfy_topic) : undefined;
      const notifyChannels = Array.isArray(args.notify_channels)
        ? (args.notify_channels as NotificationChannelType[])
        : undefined;

      const updatedWatches = watchService.bindNotificationDestination({
        recipient_email: recipientEmail,
        watch_id: watchId,
        notify_channels: notifyChannels,
        ntfy_topic: ntfyTopic,
        save_as_default: saveAsDefault,
        tenant_id: tenantId
      });

      const primaryWatch = updatedWatches[0] || null;
      const calendarLinks = primaryWatch ? buildWatchCalendarLinks(primaryWatch, baseUrl) : null;

      return {
        success: true,
        status: 'updated',
        delivery_status: 'BOUND_READY',
        destination_status: 'bound',
        bound_email: recipientEmail,
        saved_as_default_for_future_chats: saveAsDefault,
        updated_watches_count: updatedWatches.length,
        updated_watches: updatedWatches,
        calendar_links: calendarLinks
      };
    }

    case 'extract_watches_from_chat': {
      const transcript = String(args.transcript || '');
      const autoCreate = Boolean(args.auto_create ?? true);
      const extracted = chatExtractorService.extractWatchesFromTranscript(transcript, baseUrl);
      const createdWatches = [];

      const providedEmail =
        args.recipient_email && !isDisallowedAmbientEmail(String(args.recipient_email))
          ? String(args.recipient_email).trim()
          : (oauthEmail && !isDisallowedAmbientEmail(oauthEmail) ? oauthEmail : undefined);

      if (providedEmail) {
        notificationService.setSavedDefaultEmail(providedEmail, tenantId);
      }

      if (autoCreate) {
        for (const item of extracted) {
          const input = chatExtractorService.toWatchInput(item, providedEmail);
          createdWatches.push(watchService.createWatch({ ...input, tenant_id: tenantId }, tenantId));
        }
      }

      const firstWatch = createdWatches[0] || null;
      const hasBoundEmail = Boolean(firstWatch?.recipient_email && !isDisallowedAmbientEmail(firstWatch.recipient_email));

      return {
        success: true,
        status: 'extracted',
        delivery_status: hasBoundEmail ? 'BOUND_READY' : 'ACTION_REQUIRED_ASK_USER_FOR_EMAIL',
        destination_status: hasBoundEmail ? 'bound' : 'unbound',
        bound_email: hasBoundEmail ? firstWatch!.recipient_email : null,
        extracted_count: extracted.length,
        extracted_opportunities: extracted,
        created_watches: createdWatches,
        calendar_links: firstWatch ? buildWatchCalendarLinks(firstWatch, baseUrl) : null
      };
    }

    case 'list_active_watches': {
      const status = args.status ? String(args.status) : 'all';
      const watches = watchService.listWatches(status, tenantId);
      return {
        count: watches.length,
        saved_default_email: notificationService.getSavedDefaultEmail(tenantId),
        watches
      };
    }

    case 'check_watch_now': {
      const watchId = String(args.watch_id || '').trim();
      if (!watchId) {
        throw new Error('Missing required argument: watch_id');
      }
      const outcome = await resolutionEngine.runWatchCheck(watchId, { tenantId });
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
      const watchId = String(args.watch_id || '').trim();
      const action = String(args.action || '').trim();
      if (!watchId || !action) {
        throw new Error('Missing required arguments: watch_id, action');
      }
      if (action === 'delete') {
        const deleted = watchService.deleteWatch(watchId, tenantId);
        return { success: deleted, watch_id: watchId, action: 'deleted' };
      }
      const existing = watchService.getWatchById(watchId, tenantId);
      if (!existing) {
        throw new Error(`Watch "${watchId}" not found.`);
      }
      const nextStatus = action === 'pause' ? 'paused' : 'active_monitoring';
      const updated = watchService.updateWatchFields(watchId, { status: nextStatus }, tenantId);
      return { success: true, watch: updated };
    }

    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}
