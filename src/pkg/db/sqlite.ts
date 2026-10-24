import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.ts';

if (config.dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

export const db = new DatabaseSync(config.dbPath);

export function runInTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = fn();
    db.exec('COMMIT');
    return res;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function ensureColumnExists(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function runSchemaMigrations(): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
      version INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'scholarship',
      chat_context TEXT NOT NULL,
      source_chat_client TEXT NOT NULL DEFAULT 'MCP Client',
      target_url TEXT,
      secondary_url TEXT,
      trigger_type TEXT NOT NULL DEFAULT 'web_monitor',
      condition_text TEXT NOT NULL,
      expected_keywords TEXT NOT NULL DEFAULT '[]',
      closed_keywords TEXT NOT NULL DEFAULT '[]',
      window_start_date TEXT,
      window_label TEXT,
      check_interval_minutes INTEGER NOT NULL DEFAULT 60,
      poll_after INTEGER NOT NULL DEFAULT 0,
      is_auto_resolve INTEGER NOT NULL DEFAULT 1,
      proposed_outcome INTEGER,
      closing_soon_notified INTEGER NOT NULL DEFAULT 0,
      resolution_config TEXT NOT NULL DEFAULT '{}',
      oracle_responses TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active_monitoring',
      notify_channels TEXT NOT NULL DEFAULT '["in_app","email"]',
      recipient_email TEXT,
      last_checked_at TEXT,
      last_snapshot_hash TEXT,
      last_status_summary TEXT,
      detected_deadline TEXT,
      detected_apply_url TEXT,
      triggered_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS check_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
      watch_id TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      http_status INTEGER,
      is_open INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      extracted_snippet TEXT,
      page_changed INTEGER NOT NULL DEFAULT 0,
      oracle_name TEXT DEFAULT 'web_portal',
      cache_hit INTEGER NOT NULL DEFAULT 0,
      entity_validated INTEGER NOT NULL DEFAULT 1,
      next_poll_after INTEGER
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
      version INTEGER NOT NULL DEFAULT 1,
      watch_id TEXT NOT NULL,
      watch_title TEXT NOT NULL,
      channel TEXT NOT NULL,
      recipient TEXT,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'delivered',
      preview_url TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
      event_type TEXT NOT NULL,
      entity_table TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS demo_portal_state (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      organization TEXT NOT NULL,
      is_open INTEGER NOT NULL DEFAULT 0,
      open_date_text TEXT NOT NULL,
      deadline_text TEXT NOT NULL,
      award_amount TEXT NOT NULL,
      custom_banner TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  ensureColumnExists('watches', 'tenant_id', "TEXT NOT NULL DEFAULT 'tenant_default'");
  ensureColumnExists('watches', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists('watches', 'secondary_url', 'TEXT');
  ensureColumnExists('watches', 'poll_after', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('watches', 'is_auto_resolve', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists('watches', 'proposed_outcome', 'INTEGER');
  ensureColumnExists('watches', 'closing_soon_notified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('watches', 'resolution_config', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumnExists('watches', 'oracle_responses', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumnExists('watches', 'canonical_url_key', 'TEXT');
  ensureColumnExists('watches', 'rrule', 'TEXT');

  ensureColumnExists('check_logs', 'tenant_id', "TEXT NOT NULL DEFAULT 'tenant_default'");
  ensureColumnExists('check_logs', 'oracle_name', "TEXT DEFAULT 'web_portal'");
  ensureColumnExists('check_logs', 'cache_hit', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('check_logs', 'entity_validated', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists('check_logs', 'next_poll_after', 'INTEGER');

  ensureColumnExists('notifications', 'tenant_id', "TEXT NOT NULL DEFAULT 'tenant_default'");
  ensureColumnExists('notifications', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists('notifications', 'idempotency_key', 'TEXT');
  ensureColumnExists('notifications', 'attempt_count', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists('notifications', 'next_retry_at', 'INTEGER');
  ensureColumnExists('notifications', 'last_error', 'TEXT');

  // Multi-tenant channel_configs migration: ensure compound primary key (tenant_id, channel)
  const channelTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_configs'").get();
  if (channelTableInfo) {
    const cols = db.prepare('PRAGMA table_info(channel_configs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'tenant_id')) {
      db.exec(`
        CREATE TABLE channel_configs_mt (
          tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
          channel TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          config_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, channel)
        );
        INSERT OR IGNORE INTO channel_configs_mt (tenant_id, channel, enabled, config_json, updated_at)
          SELECT 'tenant_default', channel, enabled, config_json, updated_at FROM channel_configs;
        DROP TABLE channel_configs;
        ALTER TABLE channel_configs_mt RENAME TO channel_configs;
      `);
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_configs (
        tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
        channel TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, channel)
      );
    `);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency
    ON notifications(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_watches_tenant_status
    ON watches(tenant_id, status, poll_after);

    CREATE INDEX IF NOT EXISTS idx_check_logs_tenant
    ON check_logs(tenant_id, checked_at);

    CREATE INDEX IF NOT EXISTS idx_notifications_tenant
    ON notifications(tenant_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox(status, next_retry_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_outbox_tenant_entity
    ON outbox(tenant_id, entity_table, entity_id);
  `);
}
