import { config } from '../../config/index.ts';
import { oracleCache } from '../cache/oracle-cache.ts';
import { db } from './sqlite.ts';
import { DEFAULT_TENANT_ID, deriveCanonicalTenantId } from '../tenant/tenant.ts';

const SUPABASE_WATCH_COLUMNS = new Set([
  'id',
  'title',
  'category',
  'chat_context',
  'source_chat_client',
  'target_url',
  'secondary_url',
  'canonical_url_key',
  'trigger_type',
  'condition_text',
  'expected_keywords',
  'closed_keywords',
  'window_start_date',
  'window_label',
  'check_interval_minutes',
  'poll_after',
  'is_auto_resolve',
  'proposed_outcome',
  'closing_soon_notified',
  'resolution_config',
  'oracle_responses',
  'status',
  'notify_channels',
  'recipient_email',
  'last_checked_at',
  'last_snapshot_hash',
  'last_status_summary',
  'detected_deadline',
  'detected_apply_url',
  'triggered_at',
  'created_at'
]);

const SUPABASE_CHECK_LOG_COLUMNS = new Set([
  'id',
  'watch_id',
  'checked_at',
  'http_status',
  'is_open',
  'confidence',
  'summary',
  'extracted_snippet',
  'page_changed',
  'oracle_name',
  'cache_hit',
  'entity_validated',
  'next_poll_after'
]);

const SUPABASE_NOTIFICATION_COLUMNS = new Set([
  'id',
  'watch_id',
  'watch_title',
  'channel',
  'recipient',
  'subject',
  'message',
  'delivery_status',
  'preview_url',
  'idempotency_key',
  'is_read',
  'attempt_count',
  'next_retry_at',
  'last_error',
  'created_at'
]);

function sanitizeForSupabase(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const allowed =
    table === 'watches'
      ? SUPABASE_WATCH_COLUMNS
      : table === 'check_logs'
        ? SUPABASE_CHECK_LOG_COLUMNS
        : table === 'notifications'
          ? SUPABASE_NOTIFICATION_COLUMNS
          : null;

  if (!allowed) return row;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (allowed.has(key)) {
      sanitized[key] = value;
    }
  }

  if (table === 'watches') {
    const resConfig =
      typeof sanitized.resolution_config === 'object' && sanitized.resolution_config !== null
        ? { ...(sanitized.resolution_config as Record<string, unknown>) }
        : typeof sanitized.resolution_config === 'string'
          ? JSON.parse(sanitized.resolution_config)
          : {};

    const meta = { ...((resConfig.provider_metadata as Record<string, unknown>) || {}) };
    if (row.tenant_id && !meta.tenant_id) meta.tenant_id = row.tenant_id;
    if (row.rrule && !meta.rrule) meta.rrule = row.rrule;
    if (row.version !== undefined && meta.version === undefined) meta.version = row.version;
    resConfig.provider_metadata = meta;
    sanitized.resolution_config = resConfig;

    if (!sanitized.condition_text) {
      sanitized.condition_text = String(row.title || 'Event status monitor');
    }
  }

  return sanitized;
}

export interface InfrastructureStatus {
  mode: 'local_embedded' | 'cloud_hybrid';
  primaryDatabase: 'node:sqlite' | 'supabase_postgres';
  cacheBackend: 'in_memory_l1' | 'upstash_redis_l2';
  headlessScraper: 'native_fetch' | 'firecrawl_headless';
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  syncedRowsCount: number;
}

/**
 * Dual-Mode Cloud Sync Adapter:
 * - Locally & in CI tests (`PULSEREMIND_DB_PATH=:memory:`), uses zero-setup built-in `node:sqlite`.
 * - In Cloud Production (`SUPABASE_URL` configured):
 *   1. Hydrates local SQLite from Supabase on boot so watches survive Render container restarts.
 *   2. Replicates all write/update/delete mutations to Supabase PostgREST.
 *   3. Tracks `lastSyncedAt` and `lastSyncError` for instant diagnostics on `/api/health`.
 */
export class CloudDatabaseSync {
  private lastSyncedAt: string | null = null;
  private lastSyncError: string | null = null;
  private syncedRowsCount = 0;

  getStatus(): InfrastructureStatus {
    const isCloudDb = config.cloud.storageProvider !== 'sqlite';
    const isRedis = oracleCache.isDistributedRedisEnabled();
    const isFirecrawl = Boolean(config.cloud.firecrawlApiKey);

    return {
      mode: isCloudDb || isRedis ? 'cloud_hybrid' : 'local_embedded',
      primaryDatabase:
        config.cloud.storageProvider === 'supabase'
          ? 'supabase_postgres'
          : 'node:sqlite',
      cacheBackend: isRedis ? 'upstash_redis_l2' : 'in_memory_l1',
      headlessScraper: isFirecrawl ? 'firecrawl_headless' : 'native_fetch',
      lastSyncedAt: this.lastSyncedAt,
      lastSyncError: this.lastSyncError,
      syncedRowsCount: this.syncedRowsCount
    };
  }

  isCloudConfigured(): boolean {
    if (process.env.PULSEREMIND_DB_PATH === ':memory:') {
      return false;
    }
    if (config.cloud.storageProvider === 'supabase' && config.cloud.supabaseUrl && config.cloud.supabaseKey) {
      return true;
    }
    return false;
  }

  async verifySupabaseConnection(): Promise<{ ok: boolean; error: string | null }> {
    if (!config.cloud.supabaseUrl || !config.cloud.supabaseKey) {
      return { ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' };
    }
    try {
      const res = await fetch(`${config.cloud.supabaseUrl.replace(/\/$/, '')}/rest/v1/watches?select=id&limit=1`, {
        method: 'GET',
        headers: {
          apikey: config.cloud.supabaseKey,
          Authorization: `Bearer ${config.cloud.supabaseKey}`
        }
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        return { ok: false, error: `Supabase HTTP ${res.status}: ${text}` };
      }
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async replicateRow(table: string, payload: Record<string, unknown> | Array<Record<string, unknown>>): Promise<boolean> {
    if (process.env.PULSEREMIND_DB_PATH === ':memory:') {
      return true;
    }

    if (config.cloud.storageProvider === 'supabase' && config.cloud.supabaseUrl && config.cloud.supabaseKey) {
      try {
        const bodyPayload = Array.isArray(payload)
          ? payload.map((r) => sanitizeForSupabase(table, r))
          : sanitizeForSupabase(table, payload);

        const res = await fetch(`${config.cloud.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}`, {
          method: 'POST',
          headers: {
            apikey: config.cloud.supabaseKey,
            Authorization: `Bearer ${config.cloud.supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify(bodyPayload)
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          this.lastSyncError = `Supabase ${table} HTTP ${res.status}: ${errText.slice(0, 220)}`;
          return false;
        }
        this.lastSyncedAt = new Date().toISOString();
        this.lastSyncError = null;
        this.syncedRowsCount += Array.isArray(payload) ? payload.length : 1;
        return true;
      } catch (err) {
        this.lastSyncError = (err as Error).message;
        return false;
      }
    }

    return false;
  }

  async deleteRow(table: string, id: string): Promise<boolean> {
    if (config.cloud.storageProvider === 'supabase' && config.cloud.supabaseUrl && config.cloud.supabaseKey) {
      try {
        const res = await fetch(
          `${config.cloud.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,
          {
            method: 'DELETE',
            headers: {
              apikey: config.cloud.supabaseKey,
              Authorization: `Bearer ${config.cloud.supabaseKey}`
            }
          }
        );
        return res.ok;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Bidirectional Sync between Local SQLite and Cloud Supabase PostgreSQL:
   * 1. Pulls any watches stored in Supabase into local SQLite (survives Render container restarts).
   * 2. Pushes all local watches, check_logs, and notifications up to Supabase.
   */
  async syncBidirectional(): Promise<{
    pulledWatches: number;
    pushedWatches: number;
    pushedNotifications: number;
    error: string | null;
  }> {
    if (process.env.PULSEREMIND_DB_PATH === ':memory:') {
      return { pulledWatches: 0, pushedWatches: 0, pushedNotifications: 0, error: null };
    }

    let pulledWatches = 0;
    let pushedWatches = 0;
    let pushedNotifications = 0;

    if (config.cloud.storageProvider !== 'supabase' || !config.cloud.supabaseUrl || !config.cloud.supabaseKey) {
      return { pulledWatches: 0, pushedWatches: 0, pushedNotifications: 0, error: null };
    }

    const baseUrl = config.cloud.supabaseUrl.replace(/\/$/, '');
    const headers = {
      apikey: config.cloud.supabaseKey,
      Authorization: `Bearer ${config.cloud.supabaseKey}`,
      'Content-Type': 'application/json'
    };

    // 1. Pull watches from Supabase -> Local SQLite
    try {
      const getRes = await fetch(`${baseUrl}/rest/v1/watches?select=*&order=created_at.desc&limit=200`, {
        method: 'GET',
        headers
      });
      if (getRes.ok) {
        const remoteRows = (await getRes.json()) as Array<Record<string, unknown>>;
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO watches (
            id, tenant_id, version, rrule, title, category, chat_context, source_chat_client, target_url, secondary_url,
            canonical_url_key, trigger_type, condition_text, expected_keywords, closed_keywords,
            window_start_date, window_label, check_interval_minutes, poll_after,
            is_auto_resolve, proposed_outcome, closing_soon_notified,
            resolution_config, oracle_responses, status,
            notify_channels, recipient_email, last_checked_at, last_snapshot_hash,
            last_status_summary, detected_deadline, detected_apply_url, triggered_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const r of remoteRows) {
          const resConfig =
            typeof r.resolution_config === 'string'
              ? JSON.parse(r.resolution_config)
              : ((r.resolution_config as Record<string, unknown>) || {});
          const meta = ((resConfig.provider_metadata as Record<string, unknown>) || {});
          const tenantId = String(
            meta.tenant_id ||
              (r.recipient_email ? deriveCanonicalTenantId(String(r.recipient_email)) : DEFAULT_TENANT_ID)
          );
          const rrule = meta.rrule ? String(meta.rrule) : null;
          const version = Number(meta.version || 1);

          const info = insertStmt.run(
            String(r.id),
            tenantId,
            version,
            rrule,
            String(r.title),
            String(r.category || 'scholarship'),
            String(r.chat_context || ''),
            String(r.source_chat_client || 'MCP Client'),
            r.target_url ? String(r.target_url) : null,
            r.secondary_url ? String(r.secondary_url) : null,
            r.canonical_url_key ? String(r.canonical_url_key) : null,
            String(r.trigger_type || 'web_monitor'),
            String(r.condition_text || ''),
            typeof r.expected_keywords === 'string' ? r.expected_keywords : JSON.stringify(r.expected_keywords || []),
            typeof r.closed_keywords === 'string' ? r.closed_keywords : JSON.stringify(r.closed_keywords || []),
            r.window_start_date ? String(r.window_start_date) : null,
            r.window_label ? String(r.window_label) : null,
            Number(r.check_interval_minutes || 60),
            Number(r.poll_after || 0),
            r.is_auto_resolve === false || r.is_auto_resolve === 0 ? 0 : 1,
            r.proposed_outcome !== null && r.proposed_outcome !== undefined ? Number(r.proposed_outcome) : null,
            r.closing_soon_notified ? 1 : 0,
            typeof r.resolution_config === 'string' ? r.resolution_config : JSON.stringify(r.resolution_config || {}),
            typeof r.oracle_responses === 'string' ? r.oracle_responses : JSON.stringify(r.oracle_responses || []),
            String(r.status || 'active_monitoring'),
            typeof r.notify_channels === 'string' ? r.notify_channels : JSON.stringify(r.notify_channels || ['in_app']),
            r.recipient_email ? String(r.recipient_email) : null,
            r.last_checked_at ? String(r.last_checked_at) : null,
            r.last_snapshot_hash ? String(r.last_snapshot_hash) : null,
            r.last_status_summary ? String(r.last_status_summary) : null,
            r.detected_deadline ? String(r.detected_deadline) : null,
            r.detected_apply_url ? String(r.detected_apply_url) : null,
            r.triggered_at ? String(r.triggered_at) : null,
            String(r.created_at || new Date().toISOString())
          );
          if (Number(info.changes) > 0) pulledWatches++;
        }
      } else {
        const errText = await getRes.text().catch(() => getRes.statusText);
        this.lastSyncError = `Supabase GET watches HTTP ${getRes.status}: ${errText.slice(0, 220)}`;
      }
    } catch (err) {
      this.lastSyncError = (err as Error).message;
    }

    // 2. Push all local SQLite watches -> Supabase
    const localWatches = db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all() as Array<
      Record<string, unknown>
    >;
    if (localWatches.length > 0) {
      const formattedWatches = localWatches.map((r) => ({
        id: String(r.id),
        tenant_id: String(r.tenant_id || DEFAULT_TENANT_ID),
        rrule: r.rrule ? String(r.rrule) : null,
        version: Number(r.version || 1),
        title: String(r.title),
        category: String(r.category),
        chat_context: String(r.chat_context),
        source_chat_client: String(r.source_chat_client),
        target_url: r.target_url ? String(r.target_url) : null,
        secondary_url: r.secondary_url ? String(r.secondary_url) : null,
        canonical_url_key: r.canonical_url_key ? String(r.canonical_url_key) : null,
        trigger_type: String(r.trigger_type || 'web_monitor'),
        condition_text: String(r.condition_text),
        expected_keywords: JSON.parse(String(r.expected_keywords || '[]')),
        closed_keywords: JSON.parse(String(r.closed_keywords || '[]')),
        window_start_date: r.window_start_date ? String(r.window_start_date) : null,
        window_label: r.window_label ? String(r.window_label) : null,
        check_interval_minutes: Number(r.check_interval_minutes || 60),
        poll_after: Number(r.poll_after || 0),
        is_auto_resolve: Boolean(r.is_auto_resolve ?? 1),
        proposed_outcome:
          r.proposed_outcome !== null && r.proposed_outcome !== undefined ? Number(r.proposed_outcome) : null,
        closing_soon_notified: Boolean(r.closing_soon_notified),
        resolution_config: JSON.parse(String(r.resolution_config || '{}')),
        oracle_responses: JSON.parse(String(r.oracle_responses || '[]')),
        status: String(r.status || 'active_monitoring'),
        notify_channels: JSON.parse(String(r.notify_channels || '["in_app"]')),
        recipient_email: r.recipient_email ? String(r.recipient_email) : null,
        last_checked_at: r.last_checked_at ? String(r.last_checked_at) : null,
        last_snapshot_hash: r.last_snapshot_hash ? String(r.last_snapshot_hash) : null,
        last_status_summary: r.last_status_summary ? String(r.last_status_summary) : null,
        detected_deadline: r.detected_deadline ? String(r.detected_deadline) : null,
        detected_apply_url: r.detected_apply_url ? String(r.detected_apply_url) : null,
        triggered_at: r.triggered_at ? String(r.triggered_at) : null,
        created_at: String(r.created_at)
      }));

      const ok = await this.replicateRow('watches', formattedWatches);
      if (ok) pushedWatches = formattedWatches.length;
    }

    // 3. Push all local SQLite notifications -> Supabase
    const localNotifs = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all() as Array<
      Record<string, unknown>
    >;
    if (localNotifs.length > 0) {
      const formattedNotifs = localNotifs.map((n) => ({
        id: String(n.id),
        watch_id: String(n.watch_id),
        watch_title: String(n.watch_title),
        channel: String(n.channel),
        recipient: n.recipient ? String(n.recipient) : null,
        subject: String(n.subject),
        message: String(n.message),
        delivery_status: String(n.delivery_status),
        preview_url: n.preview_url ? String(n.preview_url) : null,
        idempotency_key: n.idempotency_key ? String(n.idempotency_key) : null,
        is_read: Boolean(n.is_read),
        created_at: String(n.created_at)
      }));

      const ok = await this.replicateRow('notifications', formattedNotifs);
      if (ok) pushedNotifications = formattedNotifs.length;
    }

    return {
      pulledWatches,
      pushedWatches,
      pushedNotifications,
      error: this.lastSyncError
    };
  }
}

export const cloudDatabaseSync = new CloudDatabaseSync();
