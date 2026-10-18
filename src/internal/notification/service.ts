import crypto from 'node:crypto';
import type { WatchRecord } from '../watch/model.ts';
import type { EvaluationResult } from '../resolution/types.ts';
import type { ChannelConfigRecord, NotificationChannelType, NotificationRecord } from './model.ts';
import { notificationRepository, NotificationRepository } from './repository.ts';
import { emailProvider, EmailProvider } from './providers/email.provider.ts';
import { messagingWebhookProvider, MessagingWebhookProvider } from './providers/webhook.provider.ts';

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

  listNotifications(limit = 50): NotificationRecord[] {
    return this.repo.list(limit);
  }

  markAllRead(): void {
    this.repo.markAllRead();
  }

  getChannelConfigs(): ChannelConfigRecord[] {
    return this.repo.getChannelConfigs();
  }

  updateChannelConfig(
    channel: NotificationChannelType,
    enabled: boolean,
    config: Record<string, string>
  ): ChannelConfigRecord {
    return this.repo.updateChannelConfig(channel, enabled, config);
  }

  getRenderedEmailHtml(notificationId: string): string | null {
    return this.email.getRenderedHtml(notificationId);
  }

  insertInAppAlert(params: {
    watchId: string;
    watchTitle: string;
    recipient: string;
    subject: string;
    message: string;
    previewUrl: string | null;
    idempotencyKey?: string;
  }): NotificationRecord {
    return this.repo.insert({
      watch_id: params.watchId,
      watch_title: params.watchTitle,
      channel: 'in_app',
      recipient: params.recipient,
      subject: params.subject,
      message: params.message,
      delivery_status: 'delivered',
      preview_url: params.previewUrl,
      idempotency_key: params.idempotencyKey
    }).record;
  }

  private buildIdempotencyKey(watch: WatchRecord, channel: NotificationChannelType): string {
    const cycleKey = watch.window_start_date || watch.window_label || 'default_cycle';
    return crypto
      .createHash('sha256')
      .update(`${watch.id}::${channel}::open::${cycleKey}`)
      .digest('hex')
      .slice(0, 24);
  }

  async dispatchOpenNotifications(
    watch: WatchRecord,
    evaluation: EvaluationResult,
    options: { allowDuplicateTest?: boolean } = {}
  ): Promise<NotificationRecord[]> {
    const configs = this.repo.getChannelConfigs();
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

      if (channel === 'in_app') {
        const { record, created } = this.repo.insert({
          watch_id: watch.id,
          watch_title: watch.title,
          channel: 'in_app',
          recipient: 'Dashboard Inbox',
          subject,
          message: plainMessage,
          delivery_status: 'delivered',
          preview_url: evaluation.detectedApplyUrl || watch.target_url,
          idempotency_key: idempotencyKey
        });
        if (created) sentNotifications.push(record);
        continue;
      }

      if (channel === 'email') {
        const recipient =
          watch.recipient_email || channelCfg?.config?.default_recipient || 'student@university.edu';
        const { record: notif, created } = this.repo.insert({
          watch_id: watch.id,
          watch_title: watch.title,
          channel: 'email',
          recipient,
          subject,
          message: plainMessage,
          delivery_status: 'delivered',
          preview_url: null,
          idempotency_key: idempotencyKey
        });

        if (created) {
          const html = this.email.buildOpportunityOpenHtml(watch, evaluation);
          this.email.storeRenderedHtml(notif.id, html);
          notif.preview_url = `/api/notifications/${notif.id}/email-preview`;
          sentNotifications.push(notif);
        }
        continue;
      }

      const { deliveryStatus, recipientLabel } = await this.webhook.send(
        channel,
        channelCfg,
        subject,
        plainMessage
      );

      const { record, created } = this.repo.insert({
        watch_id: watch.id,
        watch_title: watch.title,
        channel,
        recipient: recipientLabel,
        subject,
        message: plainMessage,
        delivery_status: deliveryStatus,
        preview_url: evaluation.detectedApplyUrl || watch.target_url,
        idempotency_key: idempotencyKey
      });
      if (created) sentNotifications.push(record);
    }

    return sentNotifications;
  }
}

export const notificationService = new NotificationService();
