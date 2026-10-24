import type { NotificationChannelType } from '../watch/model.ts';

export type { NotificationChannelType };

export interface NotificationRecord {
  id: string;
  tenant_id: string;
  version: number;
  watch_id: string;
  watch_title: string;
  channel: NotificationChannelType;
  recipient: string | null;
  subject: string;
  message: string;
  delivery_status: 'pending' | 'delivered' | 'opened' | 'simulated' | 'failed';
  preview_url: string | null;
  is_read: boolean;
  attempt_count?: number;
  next_retry_at?: number | null;
  last_error?: string | null;
  created_at: string;
}

export interface ChannelConfigRecord {
  tenant_id: string;
  channel: NotificationChannelType;
  enabled: boolean;
  config: Record<string, string>;
  updated_at: string;
}
