import type { ChannelConfigRecord, NotificationChannelType } from '../model.ts';

export interface WebhookDispatchResult {
  deliveryStatus: 'delivered' | 'simulated' | 'failed';
  recipientLabel: string;
}

export class MessagingWebhookProvider {
  async send(
    channel: NotificationChannelType,
    channelCfg: ChannelConfigRecord | undefined,
    subject: string,
    plainMessage: string
  ): Promise<WebhookDispatchResult> {
    let deliveryStatus: 'delivered' | 'simulated' | 'failed' = 'simulated';
    let recipientLabel = `${channel.toUpperCase()} Webhook`;

    try {
      if (channel === 'slack' && channelCfg?.config?.webhook_url) {
        recipientLabel = channelCfg.config.channel_name || 'Slack Webhook';
        const res = await fetch(channelCfg.config.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `*${subject}*\n${plainMessage}`
          })
        });
        deliveryStatus = res.ok ? 'delivered' : 'failed';
      } else if (channel === 'discord' && channelCfg?.config?.webhook_url) {
        recipientLabel = 'Discord Channel';
        const res = await fetch(channelCfg.config.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `**${subject}**\n${plainMessage}`
          })
        });
        deliveryStatus = res.ok ? 'delivered' : 'failed';
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
        deliveryStatus = res.ok ? 'delivered' : 'failed';
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
        deliveryStatus = res.ok ? 'delivered' : 'failed';
      } else {
        recipientLabel =
          channelCfg?.config?.phone_number ||
          channelCfg?.config?.channel_name ||
          channelCfg?.config?.chat_id ||
          `${channel.toUpperCase()} (Simulated Sandbox)`;
        deliveryStatus = 'simulated';
      }
    } catch {
      deliveryStatus = 'failed';
    }

    return { deliveryStatus, recipientLabel };
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
        recipientLabel: `ntfy.sh/${cleanTopic}`
      };
    } catch {
      return {
        deliveryStatus: 'failed',
        recipientLabel: `ntfy.sh/${cleanTopic}`
      };
    }
  }
}

export const messagingWebhookProvider = new MessagingWebhookProvider();

