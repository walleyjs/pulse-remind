import type { NotificationChannelType } from '../watch/model.ts';

export type { NotificationChannelType };

export interface NotificationRecord {
  id: string;
  watch_id: string;
  watch_title: string;
  channel: NotificationChannelType;
  recipient: string | null;
  subject: string;
  message: string;
  delivery_status: 'delivered' | 'simulated' | 'failed';
  preview_url: string | null;
  is_read: boolean;
  created_at: string;
}

export interface ChannelConfigRecord {
  channel: NotificationChannelType;
  enabled: boolean;
  config: Record<string, string>;
  updated_at: string;
}
