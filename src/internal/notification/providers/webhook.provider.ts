import type { ChannelConfigRecord, NotificationChannelType } from '../model.ts';
import {
  buildVapidAuthHeader,
  encryptWebPushPayload,
  generateVapidKeys
} from '../../../pkg/webpush/crypto.ts';
import { notificationRepository } from '../repository.ts';

export interface WebhookDispatchResult {
  deliveryStatus: 'delivered' | 'simulated' | 'failed';
  recipientLabel: string;
  retryAfterSeconds?: number;
  error?: string;
}

function parseRetryAfter(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const trimmed = headerVal.trim();
  const asNum = Number(trimmed);
  if (!isNaN(asNum) && asNum >= 0) {
    return asNum;
  }
  const asDate = Date.parse(trimmed);
  if (!isNaN(asDate)) {
    return Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
  }
  return undefined;
}

export class MessagingWebhookProvider {
  async send(
    channel: NotificationChannelType,
    channelCfg: ChannelConfigRecord | undefined,
    subject: string,
    plainMessage: string,
    clickUrl?: string | null
  ): Promise<WebhookDispatchResult> {
    let deliveryStatus: 'delivered' | 'simulated' | 'failed' = 'simulated';
    let recipientLabel = `${channel.toUpperCase()} Webhook`;
    let retryAfterSeconds: number | undefined;
    let error: string | undefined;

    try {
      if (channel === 'web_push') {
        const endpoint = channelCfg?.config?.endpoint || '';
        const p256dh = channelCfg?.config?.p256dh || '';
        const auth = channelCfg?.config?.auth || '';
        if (endpoint && p256dh && auth) {
          recipientLabel = `Web Push Service Worker (${new URL(endpoint).host})`;
          const serverVapid = notificationRepository.getServerVapidKeys();
          const vapidKeys =
            channelCfg?.config?.vapid_public_key && channelCfg?.config?.vapid_private_key
              ? {
                  publicKey: channelCfg.config.vapid_public_key,
                  privateKey: channelCfg.config.vapid_private_key
                }
              : serverVapid;
          const vapidSubject = channelCfg?.config?.vapid_subject || 'mailto:alerts@pulseremind.ai';
          const vapid = buildVapidAuthHeader(endpoint, vapidSubject, vapidKeys);
          const encrypted = encryptWebPushPayload(
            JSON.stringify({ title: subject, body: plainMessage, url: clickUrl || '/' }),
            { p256dh, auth }
          );

          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: vapid.authorization,
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: '86400'
            },
            body: encrypted.ciphertext
          });
          if (!res.ok) {
            deliveryStatus = 'failed';
            retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
            error = `WebPush HTTP ${res.status}`;
          } else {
            deliveryStatus = 'delivered';
          }
        } else {
          recipientLabel = 'Web Push Service Worker (Simulated)';
          deliveryStatus = 'simulated';
        }
      } else if (channel === 'slack' && channelCfg?.config?.webhook_url) {
        recipientLabel = channelCfg.config.channel_name || 'Slack Webhook';
        const res = await fetch(channelCfg.config.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `*${subject}*\n${plainMessage}`,
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: subject.slice(0, 140) }
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: plainMessage }
              }
            ]
          })
        });
        if (!res.ok) {
          deliveryStatus = 'failed';
          retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
          error = `Slack HTTP ${res.status}`;
        } else {
          deliveryStatus = 'delivered';
        }
      } else if (channel === 'discord' && channelCfg?.config?.webhook_url) {
        recipientLabel = 'Discord Channel';
        const res = await fetch(channelCfg.config.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `**${subject}**\n${plainMessage}`,
            embeds: [
              {
                title: subject.slice(0, 250),
                description: plainMessage,
                color: 1096065
              }
            ]
          })
        });
        if (!res.ok) {
          deliveryStatus = 'failed';
          retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
          error = `Discord HTTP ${res.status}`;
        } else {
          deliveryStatus = 'delivered';
        }
      } else if (
        channel === 'telegram' &&
        channelCfg?.config?.bot_token &&
        channelCfg?.config?.chat_id
      ) {
        recipientLabel = `Telegram Chat (${channelCfg.config.chat_id})`;
        const tgUrl = `https://api.telegram.org/bot${channelCfg.config.bot_token}/sendMessage`;
        const res = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channelCfg.config.chat_id,
            text: `${subject}\n\n${plainMessage}`
          })
        });
        if (!res.ok) {
          deliveryStatus = 'failed';
          retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
          error = `Telegram HTTP ${res.status}`;
        } else {
          deliveryStatus = 'delivered';
        }
      } else if (channel === 'whatsapp' && channelCfg?.config?.webhook_url) {
        recipientLabel = channelCfg.config.phone_number || 'WhatsApp / SMS';
        const res = await fetch(channelCfg.config.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: channelCfg.config.phone_number,
            body: `${subject}\n\n${plainMessage}`
          })
        });
        if (!res.ok) {
          deliveryStatus = 'failed';
          retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
          error = `WhatsApp HTTP ${res.status}`;
        } else {
          deliveryStatus = 'delivered';
        }
      } else {
        recipientLabel =
          channelCfg?.config?.phone_number ||
          channelCfg?.config?.channel_name ||
          channelCfg?.config?.chat_id ||
          `${channel.toUpperCase()} (Simulated Sandbox)`;
        deliveryStatus = 'simulated';
      }
    } catch (err) {
      deliveryStatus = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }

    return { deliveryStatus, recipientLabel, retryAfterSeconds, error };
  }

  /**
   * Sends a zero-signup native Mobile (iOS/Android) & Desktop Push Notification via ntfy.sh
   * when `NTFY_TOPIC` (or per-watch `ntfy_topic`) is configured.
   */
  async sendNtfyPush(params: {
    topic: string;
    title: string;
    message: string;
    clickUrl?: string | null;
  }): Promise<WebhookDispatchResult> {
    const cleanTopic = params.topic.trim().replace(/^https?:\/\/ntfy\.sh\//i, '');
    if (!cleanTopic) {
      return { deliveryStatus: 'simulated', recipientLabel: 'ntfy.sh (not configured)' };
    }
    try {
      const headers: Record<string, string> = {
        Title: params.title.replace(/[^\x20-\x7E]/g, '').trim() || 'PulseRemind Alert',
        Priority: 'high',
        Tags: 'bell,calendar'
      };
      if (params.clickUrl && params.clickUrl.startsWith('http')) {
        headers.Click = params.clickUrl;
      }
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(cleanTopic)}`, {
        method: 'POST',
        headers,
        body: params.message
      });
      return {
        deliveryStatus: res.ok ? 'delivered' : 'failed',
        recipientLabel: `ntfy.sh/${cleanTopic}`,
        retryAfterSeconds: !res.ok ? parseRetryAfter(res.headers.get('retry-after')) : undefined
      };
    } catch (err) {
      return {
        deliveryStatus: 'failed',
        recipientLabel: `ntfy.sh/${cleanTopic}`,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

export const messagingWebhookProvider = new MessagingWebhookProvider();
