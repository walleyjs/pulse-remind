import crypto from 'node:crypto';
import { db, runInTransaction } from '../../pkg/db/sqlite.ts';
import { cloudDatabaseSync } from '../../pkg/db/cloud-sync.ts';
import { enqueueOutbox } from '../../pkg/db/outbox.ts';
import { generateVapidKeys, type VapidKeyPair } from '../../pkg/webpush/crypto.ts';
import { DEFAULT_TENANT_ID } from '../../pkg/tenant/tenant.ts';
import { isDisallowedAmbientEmail } from '../../pkg/privacy/minimizer.ts';
import type { ChannelConfigRecord, NotificationChannelType, NotificationRecord } from './model.ts';

function mapNotificationRow(r: Record<string, unknown>): NotificationRecord {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id || DEFAULT_TENANT_ID),
    version: Number(r.version || 1),
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
  getServerVapidKeys(): VapidKeyPair {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      return {
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY
      };
    }
    const row = db
      .prepare('SELECT config_json FROM channel_configs WHERE channel = ? AND tenant_id = ?')
      .get('web_push', DEFAULT_TENANT_ID) as { config_json: string } | undefined;
    if (row) {
      try {
        const cfg = JSON.parse(row.config_json || '{}');
        if (cfg.vapid_public_key && cfg.vapid_private_key) {
          return {
            publicKey: cfg.vapid_public_key,
            privateKey: cfg.vapid_private_key
          };
        }
      } catch {}
    }
    const newKeys = generateVapidKeys();
    this.updateChannelConfig(
      'web_push',
      false,
      {
        endpoint: '',
        p256dh: '',
        auth: '',
        vapid_public_key: newKeys.publicKey,
        vapid_private_key: newKeys.privateKey,
        vapid_subject: process.env.VAPID_SUBJECT || 'mailto:alerts@pulseremind.ai'
      },
      DEFAULT_TENANT_ID
    );
    return newKeys;
  }

  seedDefaultChannels(tenantId = DEFAULT_TENANT_ID): void {
    const now = new Date().toISOString();
    const vapid = this.getServerVapidKeys();
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
          default_recipient: '',
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
      INSERT OR IGNORE INTO channel_configs (tenant_id, channel, enabled, config_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const ch of defaultChannels) {
      stmt.run(tenantId, ch.channel, ch.enabled, JSON.stringify(ch.config), now);
    }
  }

  findByIdempotencyKey(idempotencyKey: string, tenantId?: string): NotificationRecord | null {
    const row = (
      tenantId
        ? db.prepare('SELECT * FROM notifications WHERE idempotency_key = ? AND tenant_id = ? LIMIT 1').get(idempotencyKey, tenantId)
        : db.prepare('SELECT * FROM notifications WHERE idempotency_key = ? LIMIT 1').get(idempotencyKey)
    ) as Record<string, unknown> | undefined;
    return row ? mapNotificationRow(row) : null;
  }

  insert(
    entry: Omit<NotificationRecord, 'id' | 'created_at' | 'is_read' | 'tenant_id' | 'version'> & {
      idempotency_key?: string;
      tenant_id?: string;
    },
    tenantId = DEFAULT_TENANT_ID
  ): { record: NotificationRecord; created: boolean } {
    const effectiveTenantId = entry.tenant_id || tenantId;

    if (entry.idempotency_key) {
      const existing = this.findByIdempotencyKey(entry.idempotency_key, effectiveTenantId);
      if (existing) {
        if (existing.delivery_status === 'failed') {
          const nextAttempt = (existing.attempt_count || 1) + 1;
          const updatedVersion = existing.version + 1;
          return runInTransaction(() => {
            db.prepare(`
              UPDATE notifications
              SET delivery_status = ?,
                  attempt_count = ?,
                  next_retry_at = ?,
                  last_error = ?,
                  version = ?
              WHERE id = ?
            `).run(
              entry.delivery_status,
              nextAttempt,
              entry.next_retry_at ?? null,
              entry.last_error ?? null,
              updatedVersion,
              existing.id
            );
            const updated = this.findByIdempotencyKey(entry.idempotency_key!, effectiveTenantId)!;

            enqueueOutbox({
              tenant_id: effectiveTenantId,
              event_type: 'notification_updated',
              entity_table: 'notifications',
              entity_id: updated.id,
              payload: updated as unknown as Record<string, unknown>,
              version: updatedVersion
            });

            return { record: updated, created: true };
          });
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
    const version = 1;

    return runInTransaction(() => {
      db.prepare(`
        INSERT INTO notifications (
          id, tenant_id, version, watch_id, watch_title, channel, recipient, subject, message, delivery_status,
          preview_url, is_read, created_at, idempotency_key, attempt_count, next_retry_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        id,
        effectiveTenantId,
        version,
        entry.watch_id,
        entry.watch_title,
        entry.channel,
        entry.recipient ?? null,
        entry.subject,
        entry.message,
        entry.delivery_status,
        entry.preview_url ?? null,
        createdAt,
        entry.idempotency_key || null,
        attemptCount,
        nextRetryAt,
        lastError
      );

      const record: NotificationRecord = {
        id,
        tenant_id: effectiveTenantId,
        version,
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

      enqueueOutbox({
        tenant_id: effectiveTenantId,
        event_type: 'notification_created',
        entity_table: 'notifications',
        entity_id: id,
        payload: {
          ...record,
          idempotency_key: entry.idempotency_key || null
        },
        version
      });

      return {
        record,
        created: true
      };
    });
  }

  list(limit = 50, tenantId?: string): NotificationRecord[] {
    const rows = (
      tenantId && tenantId !== 'all'
        ? db.prepare('SELECT * FROM notifications WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit)
        : db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];

    return rows.map(mapNotificationRow);
  }

  getById(id: string, tenantId?: string): NotificationRecord | null {
    const row = (
      tenantId && tenantId !== 'all'
        ? db.prepare('SELECT * FROM notifications WHERE id = ? AND tenant_id = ?').get(id, tenantId)
        : db.prepare('SELECT * FROM notifications WHERE id = ?').get(id)
    ) as Record<string, unknown> | undefined;

    return row ? mapNotificationRow(row) : null;
  }

  updateDeliveryStatus(
    id: string,
    status: 'pending' | 'delivered' | 'opened' | 'simulated' | 'failed',
    tenantId?: string
  ): boolean {
    return runInTransaction(() => {
      const existing = (
        tenantId && tenantId !== 'all'
          ? db.prepare('SELECT id, version, tenant_id FROM notifications WHERE id = ? AND tenant_id = ?').get(id, tenantId)
          : db.prepare('SELECT id, version, tenant_id FROM notifications WHERE id = ?').get(id)
      ) as { id: string; version: number; tenant_id: string } | undefined;

      if (!existing) return false;

      const newVersion = (existing.version || 1) + 1;
      const res = db.prepare(`
        UPDATE notifications
        SET delivery_status = ?, version = ?, is_read = CASE WHEN ? = 'opened' THEN 1 ELSE is_read END
        WHERE id = ?
      `).run(status, newVersion, status, id);

      if (res.changes > 0) {
        enqueueOutbox({
          tenant_id: existing.tenant_id,
          event_type: 'notification_status_changed',
          entity_table: 'notifications',
          entity_id: id,
          payload: { id, delivery_status: status, version: newVersion },
          version: newVersion
        });
        return true;
      }
      return false;
    });
  }

  markAllRead(tenantId?: string): void {
    if (tenantId && tenantId !== 'all') {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND tenant_id = ?').run(tenantId);
    } else {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
    }
  }

  getChannelConfigs(tenantId = DEFAULT_TENANT_ID): ChannelConfigRecord[] {
    let rows = db
      .prepare('SELECT * FROM channel_configs WHERE tenant_id = ? ORDER BY channel ASC')
      .all(tenantId) as Record<string, unknown>[];

    if (rows.length === 0) {
      this.seedDefaultChannels(tenantId);
      rows = db
        .prepare('SELECT * FROM channel_configs WHERE tenant_id = ? ORDER BY channel ASC')
        .all(tenantId) as Record<string, unknown>[];
    }

    return rows.map((r) => ({
      tenant_id: String(r.tenant_id),
      channel: r.channel as NotificationChannelType,
      enabled: Boolean(r.enabled),
      config: JSON.parse(String(r.config_json || '{}')),
      updated_at: String(r.updated_at)
    }));
  }

  updateChannelConfig(
    channel: NotificationChannelType,
    enabled: boolean,
    config: Record<string, string>,
    tenantId = DEFAULT_TENANT_ID
  ): ChannelConfigRecord {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO channel_configs (tenant_id, channel, enabled, config_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, channel) DO UPDATE SET
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(tenantId, channel, enabled ? 1 : 0, JSON.stringify(config), now);

    return this.getChannelConfigs(tenantId).find((c) => c.channel === channel)!;
  }

  getSavedDefaultEmail(tenantId = DEFAULT_TENANT_ID): string | null {
    // Check tenant's channel config
    const emailCfg = this.getChannelConfigs(tenantId).find((c) => c.channel === 'email');
    const saved = (emailCfg?.config?.default_recipient || '').trim();
    if (saved && !isDisallowedAmbientEmail(saved)) {
      return saved;
    }
    // Only check env var if explicitly set and not disallowed
    if (tenantId === DEFAULT_TENANT_ID) {
      const envEmail = (process.env.DEFAULT_RECIPIENT_EMAIL || '').trim();
      if (envEmail && !isDisallowedAmbientEmail(envEmail)) {
        return envEmail;
      }
    }
    return null;
  }

  setSavedDefaultEmail(email: string, tenantId = DEFAULT_TENANT_ID): ChannelConfigRecord {
    const cleanEmail = email.trim();
    if (cleanEmail !== '' && isDisallowedAmbientEmail(cleanEmail)) {
      // Do not store disallowed ambient or placeholder emails
      const existing = this.getChannelConfigs(tenantId).find((c) => c.channel === 'email');
      return existing!;
    }
    const existing = this.getChannelConfigs(tenantId).find((c) => c.channel === 'email');
    const currentConfig = existing?.config || {
      default_recipient: '',
      smtp_host: '',
      smtp_port: '587',
      smtp_user: '',
      smtp_pass: '',
      from_email: 'alerts@pulseremind.ai'
    };
    return this.updateChannelConfig(
      'email',
      true,
      {
        ...currentConfig,
        default_recipient: cleanEmail
      },
      tenantId
    );
  }
}

export const notificationRepository = new NotificationRepository();
