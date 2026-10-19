import crypto from 'node:crypto';
import { db } from '../../pkg/db/sqlite.ts';
import { cloudDatabaseSync } from '../../pkg/db/cloud-sync.ts';
import { generateVapidKeys } from '../../pkg/webpush/crypto.ts';
import type { ChannelConfigRecord, NotificationChannelType, NotificationRecord } from './model.ts';

function mapNotificationRow(r: Record<string, unknown>): NotificationRecord {
  return {
    id: String(r.id),
    watch_id: String(r.watch_id),
    watch_title: String(r.watch_title),
    channel: r.channel as NotificationChannelType,
    recipient: r.recipient ? String(r.recipient) : null,
    subject: String(r.subject),
    message: String(r.message),
    delivery_status: r.delivery_status as 'delivered' | 'simulated' | 'failed',
    preview_url: r.preview_url ? String(r.preview_url) : null,
    is_read: Boolean(r.is_read),
    attempt_count: r.attempt_count !== undefined && r.attempt_count !== null ? Number(r.attempt_count) : 1,
    next_retry_at:
      r.next_retry_at !== undefined && r.next_retry_at !== null ? Number(r.next_retry_at) : null,
    last_error: r.last_error ? String(r.last_error) : null,
    created_at: String(r.created_at)
  };
}

export class NotificationRepository {
  seedDefaultChannels(): void {
    const now = new Date().toISOString();
    const vapid = generateVapidKeys();
    const defaultChannels: Array<{
      channel: NotificationChannelType;
      enabled: number;
      config: Record<string, string>;
    }> = [
      {
        channel: 'in_app',
        enabled: 1,
        config: { description: 'Real-time dashboard feed and browser alerts' }
      },
      {
        channel: 'email',
        enabled: 1,
        config: {
          default_recipient: process.env.DEFAULT_RECIPIENT_EMAIL || '',
          smtp_host: '',
          smtp_port: '587',
          smtp_user: '',
          smtp_pass: '',
          from_email: 'alerts@pulseremind.ai'
        }
      },
      {
        channel: 'web_push',
        enabled: 0,
        config: {
          endpoint: '',
          p256dh: '',
          auth: '',
          vapid_public_key: vapid.publicKey,
          vapid_private_key: vapid.privateKey,
          vapid_subject: 'mailto:alerts@pulseremind.ai'
        }
      },
      {
        channel: 'slack',
        enabled: 0,
        config: { webhook_url: '', channel_name: '#scholarship-alerts' }
      },
      {
        channel: 'discord',
        enabled: 0,
        config: { webhook_url: '' }
      },
      {
        channel: 'telegram',
        enabled: 0,
        config: { bot_token: '', chat_id: '' }
      },
      {
        channel: 'whatsapp',
        enabled: 0,
        config: { webhook_url: '', phone_number: '+15550192834' }
      }
    ];

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO channel_configs (channel, enabled, config_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    for (const ch of defaultChannels) {
      stmt.run(ch.channel, ch.enabled, JSON.stringify(ch.config), now);
    }
  }

  findByIdempotencyKey(idempotencyKey: string): NotificationRecord | null {
    const row = db
      .prepare('SELECT * FROM notifications WHERE idempotency_key = ? LIMIT 1')
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? mapNotificationRow(row) : null;
  }

  insert(
    entry: Omit<NotificationRecord, 'id' | 'created_at' | 'is_read'> & {
      idempotency_key?: string;
    }
  ): { record: NotificationRecord; created: boolean } {
    if (entry.idempotency_key) {
      const existing = this.findByIdempotencyKey(entry.idempotency_key);
      if (existing) {
        // If previously failed and now being retried, update the outbox row in-place
        if (existing.delivery_status === 'failed') {
          const nextAttempt = (existing.attempt_count || 1) + 1;
          db.prepare(`
            UPDATE notifications
            SET delivery_status = ?,
                attempt_count = ?,
                next_retry_at = ?,
                last_error = ?
            WHERE id = ?
          `).run(
            entry.delivery_status,
            nextAttempt,
            entry.next_retry_at ?? null,
            entry.last_error ?? null,
            existing.id
          );
          const updated = this.findByIdempotencyKey(entry.idempotency_key)!;
          return { record: updated, created: true };
        }
        return {
          record: existing,
          created: false
        };
      }
    }

    const id = 'notif_' + crypto.randomUUID().slice(0, 8);
    const createdAt = new Date().toISOString();
    const attemptCount = entry.attempt_count ?? 1;
    const nextRetryAt = entry.next_retry_at ?? null;
    const lastError = entry.last_error ?? null;

    db.prepare(`
      INSERT INTO notifications (
        id, watch_id, watch_title, channel, recipient, subject, message, delivery_status,
        preview_url, is_read, created_at, idempotency_key, attempt_count, next_retry_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.watch_id,
      entry.watch_title,
      entry.channel,
      entry.recipient,
      entry.subject,
      entry.message,
      entry.delivery_status,
      entry.preview_url,
      createdAt,
      entry.idempotency_key || null,
      attemptCount,
      nextRetryAt,
      lastError
    );

    const record: NotificationRecord = {
      id,
      created_at: createdAt,
      is_read: false,
      watch_id: entry.watch_id,
      watch_title: entry.watch_title,
      channel: entry.channel,
      recipient: entry.recipient,
      subject: entry.subject,
      message: entry.message,
      delivery_status: entry.delivery_status,
      preview_url: entry.preview_url,
      attempt_count: attemptCount,
      next_retry_at: nextRetryAt,
      last_error: lastError
    };

    cloudDatabaseSync
      .replicateRow('notifications', {
        ...record,
        idempotency_key: entry.idempotency_key || null
      })
      .catch(() => {});

    return {
      record,
      created: true
    };
  }

  list(limit = 50): NotificationRecord[] {
    const rows = db
      .prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];

    return rows.map(mapNotificationRow);
  }

  markAllRead(): void {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
  }

  getChannelConfigs(): ChannelConfigRecord[] {
    const rows = db.prepare('SELECT * FROM channel_configs ORDER BY channel ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      channel: r.channel as NotificationChannelType,
      enabled: Boolean(r.enabled),
      config: JSON.parse(String(r.config_json || '{}')),
      updated_at: String(r.updated_at)
    }));
  }

  updateChannelConfig(
    channel: NotificationChannelType,
    enabled: boolean,
    config: Record<string, string>
  ): ChannelConfigRecord {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO channel_configs (channel, enabled, config_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel) DO UPDATE SET
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(channel, enabled ? 1 : 0, JSON.stringify(config), now);

    return this.getChannelConfigs().find((c) => c.channel === channel)!;
  }

  getSavedDefaultEmail(): string | null {
    const envEmail = (process.env.DEFAULT_RECIPIENT_EMAIL || '').trim();
    if (envEmail && envEmail !== 'student@university.edu') {
      return envEmail;
    }
    const emailCfg = this.getChannelConfigs().find((c) => c.channel === 'email');
    const saved = (emailCfg?.config?.default_recipient || '').trim();
    if (saved && saved !== 'student@university.edu') {
      return saved;
    }
    return null;
  }

  setSavedDefaultEmail(email: string): ChannelConfigRecord {
    const cleanEmail = email.trim();
    const existing = this.getChannelConfigs().find((c) => c.channel === 'email');
    const currentConfig = existing?.config || {
      default_recipient: '',
      smtp_host: '',
      smtp_port: '587',
      smtp_user: '',
      smtp_pass: '',
      from_email: 'alerts@pulseremind.ai'
    };
    return this.updateChannelConfig('email', true, {
      ...currentConfig,
      default_recipient: cleanEmail
    });
  }
}

export const notificationRepository = new NotificationRepository();
