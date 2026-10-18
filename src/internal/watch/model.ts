export type WatchStatus =
  | 'hibernating'
  | 'active_monitoring'
  | 'proposed_open'
  | 'triggered_open'
  | 'config_error'
  | 'expired_closed'
  | 'paused';

export type TriggerType = 'web_monitor' | 'scheduled_date' | 'hybrid';
export type NotificationChannelType = 'in_app' | 'email' | 'slack' | 'discord' | 'telegram' | 'whatsapp';

/**
 * Inspired by Octopus API `ResolutionConfig` (src/internal/market/market.rs)
 */
export interface ResolutionConfig {
  primary_source_name: string;
  primary_source_url: string | null;
  secondary_source_name?: string | null;
  secondary_source_url?: string | null;
  oracle_api: 'web_portal' | 'json_api' | 'mock';
  dynamic_condition: 'applications_open' | 'deadline_approaching' | 'custom_keyword';
  provider_metadata: Record<string, string>;
  is_auto_resolve: boolean;
  entity_must_match: boolean;
}

/**
 * Inspired by Octopus API `OracleResponseRecord` (src/internal/market/market.rs)
 */
export interface OracleResponseRecord {
  oracle_name: string;
  query_url: string;
  response_json: string;
  recorded_at: string;
  cache_hit?: boolean;
  entity_validated?: boolean;
}

export interface WatchRecord {
  id: string;
  title: string;
  category: string;
  chat_context: string;
  source_chat_client: string;
  target_url: string | null;
  secondary_url: string | null;
  trigger_type: TriggerType;
  condition_text: string;
  expected_keywords: string[];
  closed_keywords: string[];
  window_start_date: string | null;
  window_label: string | null;
  check_interval_minutes: number;
  poll_after: number;
  is_auto_resolve: boolean;
  proposed_outcome: number | null;
  closing_soon_notified: boolean;
  resolution_config: ResolutionConfig;
  oracle_responses: OracleResponseRecord[];
  status: WatchStatus;
  notify_channels: NotificationChannelType[];
  recipient_email: string | null;
  last_checked_at: string | null;
  last_snapshot_hash: string | null;
  last_status_summary: string | null;
  detected_deadline: string | null;
  detected_apply_url: string | null;
  triggered_at: string | null;
  created_at: string;
}

export interface CheckLogRecord {
  id: string;
  watch_id: string;
  checked_at: string;
  http_status: number | null;
  is_open: boolean;
  confidence: number;
  summary: string;
  extracted_snippet: string | null;
  page_changed: boolean;
  oracle_name?: string;
  cache_hit?: boolean;
  entity_validated?: boolean;
  next_poll_after?: number;
}

export interface CreateWatchInput {
  title: string;
  category?: string;
  chat_context: string;
  source_chat_client?: string;
  target_url?: string | null;
  secondary_url?: string | null;
  trigger_type?: TriggerType;
  condition_text?: string;
  expected_keywords?: string[];
  closed_keywords?: string[];
  window_start_date?: string | null;
  window_label?: string | null;
  check_interval_minutes?: number;
  notify_channels?: NotificationChannelType[];
  recipient_email?: string | null;
  resolution_config?: Partial<ResolutionConfig>;
}
