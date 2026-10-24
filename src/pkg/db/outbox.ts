import crypto from 'node:crypto';
import { db } from './sqlite.ts';
import { cloudDatabaseSync } from './cloud-sync.ts';
import { DEFAULT_TENANT_ID } from '../tenant/tenant.ts';

export interface OutboxRecord {
  id: string;
  tenant_id: string;
  event_type: string;
  entity_table: string;
  entity_id: string;
  payload: Record<string, unknown>;
  version: number;
  status: 'pending' | 'processing' | 'published' | 'failed';
  retry_count: number;
  last_error: string | null;
  next_retry_at: number;
  created_at: string;
  processed_at: string | null;
}

export interface EnqueueOutboxInput {
  tenant_id?: string;
  event_type: string;
  entity_table: string;
  entity_id: string;
  payload: Record<string, unknown>;
  version?: number;
}

/**
 * Commits an outbox event into the local SQLite outbox table.
 * Must be executed within the same active database transaction as the entity mutation.
 */
export function enqueueOutbox(input: EnqueueOutboxInput): OutboxRecord {
  const id = 'out_' + crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const tenantId = input.tenant_id || DEFAULT_TENANT_ID;
  const version = input.version ?? 1;

  db.prepare(`
    INSERT INTO outbox (
      id, tenant_id, event_type, entity_table, entity_id, payload_json, version,
      status, retry_count, last_error, next_retry_at, created_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, 0, ?, NULL)
  `).run(
    id,
    tenantId,
    input.event_type,
    input.entity_table,
    input.entity_id,
    JSON.stringify(input.payload),
    version,
    now
  );

  return {
    id,
    tenant_id: tenantId,
    event_type: input.event_type,
    entity_table: input.entity_table,
    entity_id: input.entity_id,
    payload: input.payload,
    version,
    status: 'pending',
    retry_count: 0,
    last_error: null,
    next_retry_at: 0,
    created_at: now,
    processed_at: null
  };
}

export type OutboxReplicatorFn = (record: OutboxRecord) => Promise<boolean>;

export class OutboxProcessor {
  private timer: NodeJS.Timeout | null = null;
  private customReplicator: OutboxReplicatorFn | null = null;

  setReplicator(fn: OutboxReplicatorFn | null): void {
    this.customReplicator = fn;
  }

  getPendingCount(tenantId?: string): number {
    if (tenantId) {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM outbox WHERE status IN ('pending', 'failed') AND tenant_id = ?")
        .get(tenantId) as { count: number };
      return row.count;
    }
    const row = db
      .prepare("SELECT COUNT(*) as count FROM outbox WHERE status IN ('pending', 'failed')")
      .get() as { count: number };
    return row.count;
  }

  listEvents(tenantId?: string, limit = 50): OutboxRecord[] {
    const rows = (
      tenantId
        ? db.prepare('SELECT * FROM outbox WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(tenantId, limit)
        : db.prepare('SELECT * FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: String(r.id),
      tenant_id: String(r.tenant_id),
      event_type: String(r.event_type),
      entity_table: String(r.entity_table),
      entity_id: String(r.entity_id),
      payload: JSON.parse(String(r.payload_json || '{}')),
      version: Number(r.version || 1),
      status: r.status as 'pending' | 'processing' | 'published' | 'failed',
      retry_count: Number(r.retry_count || 0),
      last_error: r.last_error ? String(r.last_error) : null,
      next_retry_at: Number(r.next_retry_at || 0),
      created_at: String(r.created_at),
      processed_at: r.processed_at ? String(r.processed_at) : null
    }));
  }

  /**
   * Idempotently drains pending outbox events and replicates them to Supabase PostgreSQL / Cloud storage.
   * Uses monotonic version check and exponential backoff on network failures.
   */
  async drainOutbox(limit = 50): Promise<{ processed: number; succeeded: number; failed: number }> {
    const nowUnix = Math.floor(Date.now() / 1000);
    const rows = db
      .prepare(`
        SELECT * FROM outbox
        WHERE status IN ('pending', 'failed')
          AND next_retry_at <= ?
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `)
      .all(nowUnix, limit) as Record<string, unknown>[];

    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      const record: OutboxRecord = {
        id: String(row.id),
        tenant_id: String(row.tenant_id),
        event_type: String(row.event_type),
        entity_table: String(row.entity_table),
        entity_id: String(row.entity_id),
        payload: JSON.parse(String(row.payload_json || '{}')),
        version: Number(row.version || 1),
        status: row.status as 'pending' | 'processing' | 'published' | 'failed',
        retry_count: Number(row.retry_count || 0),
        last_error: row.last_error ? String(row.last_error) : null,
        next_retry_at: Number(row.next_retry_at || 0),
        created_at: String(row.created_at),
        processed_at: row.processed_at ? String(row.processed_at) : null
      };

      // Mark status as processing
      db.prepare("UPDATE outbox SET status = 'processing' WHERE id = ?").run(record.id);

      try {
        let isSuccess = false;
        if (this.customReplicator) {
          isSuccess = await this.customReplicator(record);
        } else if (record.event_type === 'deleted' || record.event_type === 'watch_deleted') {
          isSuccess = await cloudDatabaseSync.deleteRow(record.entity_table, record.entity_id);
        } else {
          isSuccess = await cloudDatabaseSync.replicateRow(record.entity_table, {
            ...record.payload,
            tenant_id: record.tenant_id,
            version: record.version
          });
        }

        if (isSuccess || (!this.customReplicator && !cloudDatabaseSync.isCloudConfigured())) {
          // Successfully published to cloud or confirmed locally
          const nowIso = new Date().toISOString();
          db.prepare(`
            UPDATE outbox
            SET status = 'published',
                processed_at = ?,
                last_error = NULL
            WHERE id = ?
          `).run(nowIso, record.id);
          succeeded++;
        } else {
          throw new Error('Cloud replication returned false or unreachable');
        }
      } catch (err) {
        const nextRetryCount = record.retry_count + 1;
        // Exponential backoff: 2s, 4s, 8s, 16s ... capped at 300s
        const backoffSeconds = Math.min(300, Math.pow(2, nextRetryCount) * 2);
        const nextRetryTime = nowUnix + backoffSeconds;
        const errMsg = err instanceof Error ? err.message : String(err);

        db.prepare(`
          UPDATE outbox
          SET status = 'failed',
              retry_count = ?,
              next_retry_at = ?,
              last_error = ?
          WHERE id = ?
        `).run(nextRetryCount, nextRetryTime, errMsg.slice(0, 255), record.id);
        failed++;
      }
    }

    return { processed: rows.length, succeeded, failed };
  }

  async drainAll(maxBatches = 10): Promise<{ processed: number; succeeded: number; failed: number }> {
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;

    for (let i = 0; i < maxBatches; i++) {
      const result = await this.drainOutbox(50);
      totalProcessed += result.processed;
      totalSucceeded += result.succeeded;
      totalFailed += result.failed;
      if (result.processed === 0) break;
    }

    return { processed: totalProcessed, succeeded: totalSucceeded, failed: totalFailed };
  }

  start(intervalMs = 4000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drainOutbox(25).catch(() => {});
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const outboxProcessor = new OutboxProcessor();
