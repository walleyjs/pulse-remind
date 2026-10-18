import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.ts';

if (config.dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

export const db = new DatabaseSync(config.dbPath);

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

    CREATE TABLE IF NOT EXISTS channel_configs (
      channel TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
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

  ensureColumnExists('watches', 'secondary_url', 'TEXT');
  ensureColumnExists('watches', 'poll_after', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('watches', 'is_auto_resolve', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists('watches', 'proposed_outcome', 'INTEGER');
  ensureColumnExists('watches', 'closing_soon_notified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('watches', 'resolution_config', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumnExists('watches', 'oracle_responses', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumnExists('watches', 'canonical_url_key', 'TEXT');

  ensureColumnExists('check_logs', 'oracle_name', "TEXT DEFAULT 'web_portal'");
  ensureColumnExists('check_logs', 'cache_hit', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('check_logs', 'entity_validated', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists('check_logs', 'next_poll_after', 'INTEGER');

  ensureColumnExists('notifications', 'idempotency_key', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency
    ON notifications(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);
}

