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
}

export const messagingWebhookProvider = new MessagingWebhookProvider();
