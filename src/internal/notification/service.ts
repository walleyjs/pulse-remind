import crypto from 'node:crypto';
import type { WatchRecord } from '../watch/model.ts';
import type { EvaluationResult } from '../resolution/types.ts';
import type { ChannelConfigRecord, NotificationChannelType, NotificationRecord } from './model.ts';
import { notificationRepository, NotificationRepository } from './repository.ts';
import { emailProvider, EmailProvider } from './providers/email.provider.ts';
import { messagingWebhookProvider, MessagingWebhookProvider } from './providers/webhook.provider.ts';
import { DEFAULT_TENANT_ID } from '../../pkg/tenant/tenant.ts';
import { isDisallowedAmbientEmail } from '../../pkg/privacy/minimizer.ts';

export class NotificationService {
  private readonly repo: NotificationRepository;
  private readonly email: EmailProvider;
  private readonly webhook: MessagingWebhookProvider;

  constructor(
    repo: NotificationRepository = notificationRepository,
    email: EmailProvider = emailProvider,
    webhook: MessagingWebhookProvider = messagingWebhookProvider
  ) {
    this.repo = repo;
    this.email = email;
    this.webhook = webhook;
  }

  listNotifications(limit = 50, tenantId?: string): NotificationRecord[] {
    return this.repo.list(limit, tenantId);
  }

  getNotificationById(id: string, tenantId?: string): NotificationRecord | null {
    return this.repo.getById(id, tenantId);
  }

  updateDeliveryStatus(
    id: string,
    status: 'pending' | 'delivered' | 'opened' | 'simulated' | 'failed',
    tenantId?: string
  ): boolean {
    return this.repo.updateDeliveryStatus(id, status, tenantId);
  }

  markAllRead(tenantId?: string): void {
    this.repo.markAllRead(tenantId);
  }

  getChannelConfigs(tenantId = DEFAULT_TENANT_ID): ChannelConfigRecord[] {
    return this.repo.getChannelConfigs(tenantId);
  }

  updateChannelConfig(
    channel: NotificationChannelType,
    enabled: boolean,
    config: Record<string, string>,
    tenantId = DEFAULT_TENANT_ID
  ): ChannelConfigRecord {
    return this.repo.updateChannelConfig(channel, enabled, config, tenantId);
  }

  getSavedDefaultEmail(tenantId = DEFAULT_TENANT_ID): string | null {
    return this.repo.getSavedDefaultEmail(tenantId);
  }

  setSavedDefaultEmail(email: string, tenantId = DEFAULT_TENANT_ID): ChannelConfigRecord {
    return this.repo.setSavedDefaultEmail(email, tenantId);
  }

  getRenderedEmailHtml(notificationId: string): string | null {
    return this.email.getRenderedHtml(notificationId);
  }

  insertInAppAlert(params: {
    watchId: string;
    watchTitle: string;
    recipient?: string;
    subject?: string;
    message?: string;
    summary?: string;
    details?: string;
    previewUrl?: string | null;
    idempotencyKey?: string;
    tenantId?: string;
  }): NotificationRecord {
    const tenantId = params.tenantId || DEFAULT_TENANT_ID;
    const subject = params.subject || params.summary || 'PulseRemind In-App Notification';
    const message = params.message || params.details || params.summary || '';
    const recipient = params.recipient || 'in_app_feed';
    return this.repo.insert(
      {
        watch_id: params.watchId,
        watch_title: params.watchTitle,
        channel: 'in_app',
        recipient,
        subject,
        message,
        delivery_status: 'delivered',
        preview_url: params.previewUrl ?? null,
        idempotency_key: params.idempotencyKey
      },
      tenantId
    ).record;
  }

  private buildIdempotencyKey(watch: WatchRecord, channel: NotificationChannelType): string {
    const cycleKey = watch.window_start_date || watch.window_label || 'default_cycle';
    return crypto
      .createHash('sha256')
      .update(`${watch.tenant_id}::${watch.id}::${channel}::open::${cycleKey}`)
      .digest('hex')
      .slice(0, 24);
  }

  async dispatchOpenNotifications(
    watch: WatchRecord,
    evaluation: EvaluationResult,
    options: { allowDuplicateTest?: boolean; nowUnix?: number } = {}
  ): Promise<NotificationRecord[]> {
    const tenantId = watch.tenant_id || DEFAULT_TENANT_ID;
    const nowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000);
    const configs = this.repo.getChannelConfigs(tenantId);
    const configMap = new Map(configs.map((c) => [c.channel, c]));
    const sentNotifications: NotificationRecord[] = [];

    const channelsToTrigger = new Set<NotificationChannelType>(watch.notify_channels);
    for (const cfg of configs) {
      if (cfg.enabled) {
        channelsToTrigger.add(cfg.channel);
      }
    }

    const subject = `🟢 OPEN NOW: ${watch.title} is accepting applications!`;
    const plainMessage =
      `Your tracked opportunity "${watch.title}" (planned in ${watch.source_chat_client}) is now OPEN!\n` +
      `• Context from your AI chat: ${watch.chat_context}\n` +
      `• Detection Summary: ${evaluation.summary}\n` +
      (evaluation.detectedDeadline ? `• Deadline: ${evaluation.detectedDeadline}\n` : '') +
      `• Apply Link: ${evaluation.detectedApplyUrl || watch.target_url || 'N/A'}`;

    for (const channel of channelsToTrigger) {
      const channelCfg = configMap.get(channel);
      const idempotencyKey = options.allowDuplicateTest
        ? undefined
        : this.buildIdempotencyKey(watch, channel);

      // Check existing outbox state before making external network calls
      if (idempotencyKey) {
        const existing = this.repo.findByIdempotencyKey(idempotencyKey, tenantId);
        if (existing) {
          if (existing.delivery_status !== 'failed') {
            // Already delivered or simulated for this watch + channel + cycle
            continue;
          }
          if (existing.next_retry_at && existing.next_retry_at > nowUnix) {
            // Respect Retry-After / exponential backoff window
            continue;
          }
        }
      }

      if (channel === 'in_app') {
        const { record, created } = this.repo.insert(
          {
            watch_id: watch.id,
            watch_title: watch.title,
            channel: 'in_app',
            recipient: 'Dashboard Inbox',
            subject,
            message: plainMessage,
            delivery_status: 'delivered',
            preview_url: evaluation.detectedApplyUrl || watch.target_url,
            idempotency_key: idempotencyKey
          },
          tenantId
        );
        if (created) sentNotifications.push(record);
        continue;
      }

      if (channel === 'email') {
        const recipient =
          watch.recipient_email ||
          channelCfg?.config?.default_recipient ||
          this.repo.getSavedDefaultEmail(tenantId);
        if (!recipient || isDisallowedAmbientEmail(recipient)) {
          // Skip email dispatch if destination is unconfigured or a disallowed ambient placeholder
          continue;
        }
        const html = this.email.buildOpportunityOpenHtml(watch, evaluation);
        const icsAttachment = this.email.buildWatchIcsAttachment(watch);
        const sendResult = await this.email.sendEmail({
          to: recipient,
          subject,
          html,
          text: plainMessage,
          fromEmail: channelCfg?.config?.from_email,
          icsAttachmentContent: icsAttachment,
          icsFilename: `${watch.id}.ics`
        });

        const nextRetryAt =
          sendResult.deliveryStatus === 'failed'
            ? nowUnix + (sendResult.retryAfterSeconds ?? 60)
            : null;

        const { record: notif, created } = this.repo.insert(
          {
            watch_id: watch.id,
            watch_title: watch.title,
            channel: 'email',
            recipient,
            subject,
            message: plainMessage,
            delivery_status: sendResult.deliveryStatus === 'failed' ? 'failed' : 'delivered',
            preview_url: null,
            idempotency_key: idempotencyKey,
            next_retry_at: nextRetryAt,
            last_error: sendResult.error || null
          },
          tenantId
        );

        if (created) {
          this.email.storeRenderedHtml(notif.id, html);
          notif.preview_url = `/api/notifications/${notif.id}/email-preview`;
          sentNotifications.push(notif);
        }
        continue;
      }

      const { deliveryStatus, recipientLabel, retryAfterSeconds, error } = await this.webhook.send(
        channel,
        channelCfg,
        subject,
        plainMessage
      );

      const nextRetryAt =
        deliveryStatus === 'failed' ? nowUnix + (retryAfterSeconds ?? 60) : null;

      const { record, created } = this.repo.insert(
        {
          watch_id: watch.id,
          watch_title: watch.title,
          channel,
          recipient: recipientLabel,
          subject,
          message: plainMessage,
          delivery_status: deliveryStatus,
          preview_url: evaluation.detectedApplyUrl || watch.target_url,
          idempotency_key: idempotencyKey,
          next_retry_at: nextRetryAt,
          last_error: error || null
        },
        tenantId
      );
      if (created) sentNotifications.push(record);
    }

    // Optional zero-signup Mobile/Desktop Push via ntfy.sh (per-watch claim or global NTFY_TOPIC env var)
    const ntfyTopic =
      watch.resolution_config?.provider_metadata?.ntfy_topic || process.env.NTFY_TOPIC || '';
    if (ntfyTopic) {
      await this.webhook.sendNtfyPush({
        topic: ntfyTopic,
        title: subject,
        message: plainMessage,
        clickUrl: evaluation.detectedApplyUrl || watch.target_url
      });
    }

    return sentNotifications;
  }
}

export const notificationService = new NotificationService();
