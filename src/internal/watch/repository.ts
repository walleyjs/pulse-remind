import crypto from 'node:crypto';
import { db } from '../../pkg/db/sqlite.ts';
import { cloudDatabaseSync } from '../../pkg/db/cloud-sync.ts';
import { notificationRepository } from '../notification/repository.ts';
import type {
  CheckLogRecord,
  CreateWatchInput,
  NotificationChannelType,
  OracleResponseRecord,
  ResolutionConfig,
  TriggerType,
  WatchRecord,
  WatchStatus
} from './model.ts';

function mapWatchRow(row: Record<string, unknown>): WatchRecord {
  const targetUrl = row.target_url ? String(row.target_url) : null;
  const secondaryUrl = row.secondary_url ? String(row.secondary_url) : null;
  let parsedResConfig: Partial<ResolutionConfig> = {};
  try {
    parsedResConfig = JSON.parse(String(row.resolution_config || '{}'));
  } catch {
    parsedResConfig = {};
  }

  const resolutionConfig: ResolutionConfig = {
    primary_source_name: parsedResConfig.primary_source_name || 'Official Portal',
    primary_source_url: parsedResConfig.primary_source_url ?? targetUrl,
    secondary_source_name: parsedResConfig.secondary_source_name || null,
    secondary_source_url: parsedResConfig.secondary_source_url ?? secondaryUrl,
    oracle_api: parsedResConfig.oracle_api || 'web_portal',
    dynamic_condition: parsedResConfig.dynamic_condition || 'applications_open',
    provider_metadata: parsedResConfig.provider_metadata || {},
    is_auto_resolve: parsedResConfig.is_auto_resolve ?? Boolean(row.is_auto_resolve ?? 1),
    entity_must_match: parsedResConfig.entity_must_match ?? true
  };

  let oracleResponses: OracleResponseRecord[] = [];
  try {
    oracleResponses = JSON.parse(String(row.oracle_responses || '[]'));
  } catch {
    oracleResponses = [];
  }

  return {
    id: String(row.id),
    title: String(row.title),
    category: String(row.category),
    chat_context: String(row.chat_context),
    source_chat_client: String(row.source_chat_client),
    target_url: targetUrl,
    secondary_url: secondaryUrl,
    trigger_type: (row.trigger_type as TriggerType) || 'web_monitor',
    condition_text: String(row.condition_text),
    expected_keywords: JSON.parse(String(row.expected_keywords || '[]')),
    closed_keywords: JSON.parse(String(row.closed_keywords || '[]')),
    window_start_date: row.window_start_date ? String(row.window_start_date) : null,
    window_label: row.window_label ? String(row.window_label) : null,
    check_interval_minutes: Number(row.check_interval_minutes || 60),
    poll_after: Number(row.poll_after || 0),
    is_auto_resolve: Boolean(row.is_auto_resolve ?? 1),
    proposed_outcome:
      row.proposed_outcome !== null && row.proposed_outcome !== undefined
        ? Number(row.proposed_outcome)
        : null,
    closing_soon_notified: Boolean(row.closing_soon_notified),
    resolution_config: resolutionConfig,
    oracle_responses: oracleResponses,
    status: (row.status as WatchStatus) || 'active_monitoring',
    notify_channels: JSON.parse(String(row.notify_channels || '["in_app","email"]')),
    recipient_email: row.recipient_email ? String(row.recipient_email) : null,
    last_checked_at: row.last_checked_at ? String(row.last_checked_at) : null,
    last_snapshot_hash: row.last_snapshot_hash ? String(row.last_snapshot_hash) : null,
    last_status_summary: row.last_status_summary ? String(row.last_status_summary) : null,
    detected_deadline: row.detected_deadline ? String(row.detected_deadline) : null,
    detected_apply_url: row.detected_apply_url ? String(row.detected_apply_url) : null,
    triggered_at: row.triggered_at ? String(row.triggered_at) : null,
    created_at: String(row.created_at)
  };
}

export function determineInitialStatusAndPollAfter(
  windowStartDate?: string | null,
  targetUrl?: string | null
): { status: WatchStatus; pollAfter: number } {
  const nowUnix = Math.floor(Date.now() / 1000);
  if (!windowStartDate) return { status: 'active_monitoring', pollAfter: nowUnix };
  const start = new Date(windowStartDate);
  if (isNaN(start.getTime())) return { status: 'active_monitoring', pollAfter: nowUnix };

  const startUnix = Math.floor(start.getTime() / 1000);
  const diffDays = (startUnix - nowUnix) / 86400;

  if (diffDays > 21 && targetUrl) {
    return {
      status: 'hibernating',
      pollAfter: Math.max(nowUnix, startUnix - 7 * 86400)
    };
  }
  return { status: 'active_monitoring', pollAfter: nowUnix };
}

export class WatchRepository {
  count(): number {
    const row = db.prepare('SELECT COUNT(*) as count FROM watches').get() as { count: number };
    return row.count;
  }

  create(input: CreateWatchInput): WatchRecord {
    const id = 'watch_' + crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const expectedKeywords =
      input.expected_keywords && input.expected_keywords.length > 0
        ? input.expected_keywords
        : [
            'applications are open',
            'applications are now open',
            'apply now',
            'start application',
            'registration open',
            'registration is open',
            'registration is now open',
            'register now',
            'tickets available',
            'tickets are now on sale',
            'on sale now',
            'get tickets',
            'buy tickets',
            'enrollment is open'
          ];
    const closedKeywords =
      input.closed_keywords && input.closed_keywords.length > 0
        ? input.closed_keywords
        : [
            'currently closed',
            'not yet open',
            'check back soon',
            'applications closed',
            'registration closed',
            'not yet on sale',
            'opening soon'
          ];

    const { status, pollAfter } = determineInitialStatusAndPollAfter(input.window_start_date, input.target_url);
    const triggerType: TriggerType =
      input.trigger_type || (input.target_url ? (input.window_start_date ? 'hybrid' : 'web_monitor') : 'scheduled_date');

    const resConfig: ResolutionConfig = {
      primary_source_name: input.resolution_config?.primary_source_name || 'Official Event & Opportunity Portal',
      primary_source_url: input.target_url || null,
      secondary_source_name: input.resolution_config?.secondary_source_name || 'Backup Mirror',
      secondary_source_url: input.secondary_url || input.resolution_config?.secondary_source_url || null,
      oracle_api: input.resolution_config?.oracle_api || 'web_portal',
      dynamic_condition: input.resolution_config?.dynamic_condition || 'applications_open',
      provider_metadata: {
        ...(input.window_start_date ? { event_start_time: input.window_start_date } : {}),
        ...(input.resolution_config?.provider_metadata || {})
      },
      is_auto_resolve: input.resolution_config?.is_auto_resolve ?? true,
      entity_must_match: input.resolution_config?.entity_must_match ?? true
    };

    const initialSummary =
      status === 'hibernating'
        ? `Pre-window hibernation active (poll_after set for ${input.window_label || input.window_start_date})`
        : 'Ready for Resolution Engine check...';

    const explicitEmail =
      input.recipient_email && input.recipient_email.trim() && input.recipient_email.trim() !== 'student@university.edu'
        ? input.recipient_email.trim()
        : null;
    const resolvedEmail = explicitEmail || notificationRepository.getSavedDefaultEmail() || null;

    db.prepare(`
      INSERT INTO watches (
        id, title, category, chat_context, source_chat_client, target_url, secondary_url,
        trigger_type, condition_text, expected_keywords, closed_keywords,
        window_start_date, window_label, check_interval_minutes, poll_after,
        is_auto_resolve, resolution_config, status,
        notify_channels, recipient_email, last_status_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.category || 'event_or_opportunity',
      input.chat_context,
      input.source_chat_client || 'MCP Client',
      input.target_url || null,
      input.secondary_url || null,
      triggerType,
      input.condition_text || `Notify when ${input.title} opens`,
      JSON.stringify(expectedKeywords),
      JSON.stringify(closedKeywords),
      input.window_start_date || null,
      input.window_label || null,
      input.check_interval_minutes || 60,
      pollAfter,
      JSON.stringify(resConfig),
      status,
      JSON.stringify(input.notify_channels || ['in_app', 'email']),
      resolvedEmail,
      initialSummary,
      now
    );

    const created = this.getById(id)!;
    cloudDatabaseSync.replicateRow('watches', created as unknown as Record<string, unknown>).catch(() => {});
    return created;
  }

  list(statusFilter?: string): WatchRecord[] {
    if (statusFilter && statusFilter !== 'all') {
      const rows = db
        .prepare('SELECT * FROM watches WHERE status = ? ORDER BY created_at DESC')
        .all(statusFilter) as Record<string, unknown>[];
      return rows.map(mapWatchRow);
    }
    const rows = db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(mapWatchRow);
  }

  getReadyForResolution(nowUnix = Math.floor(Date.now() / 1000)): WatchRecord[] {
    const rows = db
      .prepare(`
        SELECT * FROM watches
        WHERE is_auto_resolve = 1
          AND status IN ('active_monitoring', 'hibernating')
          AND poll_after <= ?
        ORDER BY poll_after ASC
      `)
      .all(nowUnix) as Record<string, unknown>[];
    return rows.map(mapWatchRow);
  }

  getById(id: string): WatchRecord | null {
    const row = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapWatchRow(row) : null;
  }

  findBySubscriberToken(token: string): WatchRecord | null {
    const all = this.list();
    return (
      all.find(
        (w) => w.resolution_config?.provider_metadata?.subscriber_token === token
      ) || null
    );
  }

  claimSubscriberToken(
    token: string,
    params: {
      recipient_email?: string;
      notify_channels?: NotificationChannelType[];
      ntfy_topic?: string;
    }
  ): WatchRecord | null {
    const watch = this.findBySubscriberToken(token);
    if (!watch) return null;

    if (params.recipient_email && params.recipient_email.trim()) {
      notificationRepository.setSavedDefaultEmail(params.recipient_email.trim());
    }

    const nextChannels =
      params.notify_channels && params.notify_channels.length > 0
        ? params.notify_channels
        : watch.notify_channels;
    const nextEmail = params.recipient_email ?? watch.recipient_email;
    const nextResConfig = {
      ...watch.resolution_config,
      provider_metadata: {
        ...watch.resolution_config.provider_metadata,
        ...(params.ntfy_topic ? { ntfy_topic: params.ntfy_topic.trim() } : {}),
        claimed_at: new Date().toISOString()
      }
    };

    db.prepare(`
      UPDATE watches
      SET recipient_email = ?,
          notify_channels = ?,
          resolution_config = ?
      WHERE id = ?
    `).run(nextEmail, JSON.stringify(nextChannels), JSON.stringify(nextResConfig), watch.id);

    const updated = this.getById(watch.id);
    if (updated) {
      cloudDatabaseSync.replicateRow('watches', updated as unknown as Record<string, unknown>).catch(() => {});
    }
    return updated;
  }

  bindNotificationDestination(params: {
    recipient_email: string;
    watch_id?: string;
    notify_channels?: NotificationChannelType[];
    ntfy_topic?: string;
    save_as_default?: boolean;
  }): WatchRecord[] {
    const cleanEmail = params.recipient_email.trim();
    if (params.save_as_default !== false && cleanEmail) {
      notificationRepository.setSavedDefaultEmail(cleanEmail);
    }

    const targetIds = new Set<string>();
    if (params.watch_id) {
      targetIds.add(params.watch_id);
    }

    // Also bind any currently unbound watches (or most recent watch if watch_id omitted)
    const allWatches = this.list();
    for (const w of allWatches) {
      if (!w.recipient_email || w.recipient_email === 'student@university.edu') {
        targetIds.add(w.id);
      }
    }
    if (targetIds.size === 0 && allWatches.length > 0) {
      targetIds.add(allWatches[0].id);
    }

    const updatedWatches: WatchRecord[] = [];
    for (const id of targetIds) {
      const watch = this.getById(id);
      if (!watch) continue;
      const mergedChannels = Array.from(
        new Set<NotificationChannelType>([
          ...(params.notify_channels || watch.notify_channels),
          'in_app',
          'email'
        ])
      );
      const nextResConfig = {
        ...watch.resolution_config,
        provider_metadata: {
          ...watch.resolution_config.provider_metadata,
          ...(params.ntfy_topic ? { ntfy_topic: params.ntfy_topic.trim() } : {}),
          claimed_at: new Date().toISOString()
        }
      };

      db.prepare(`
        UPDATE watches
        SET recipient_email = ?,
            notify_channels = ?,
            resolution_config = ?
        WHERE id = ?
      `).run(cleanEmail, JSON.stringify(mergedChannels), JSON.stringify(nextResConfig), id);

      const updated = this.getById(id);
      if (updated) {
        updatedWatches.push(updated);
        cloudDatabaseSync.replicateRow('watches', updated as unknown as Record<string, unknown>).catch(() => {});
      }
    }

    return updatedWatches;
  }

  addOracleResponse(id: string, record: OracleResponseRecord): void {
    const watch = this.getById(id);
    if (!watch) return;
    const updated = [record, ...watch.oracle_responses].slice(0, 10);
    db.prepare('UPDATE watches SET oracle_responses = ? WHERE id = ?').run(JSON.stringify(updated), id);
  }

  updatePollAfter(id: string, pollAfterUnix: number, summary?: string): void {
    if (summary) {
      db.prepare('UPDATE watches SET poll_after = ?, last_status_summary = ? WHERE id = ?').run(
        pollAfterUnix,
        summary,
        id
      );
    } else {
      db.prepare('UPDATE watches SET poll_after = ? WHERE id = ?').run(pollAfterUnix, id);
    }
  }

  disableAutoResolveOnEntityMismatch(id: string, reason: string): WatchRecord | null {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE watches
      SET is_auto_resolve = 0,
          status = 'config_error',
          last_checked_at = ?,
          last_status_summary = ?
      WHERE id = ?
    `).run(now, reason, id);
    const updated = this.getById(id);
    if (updated) {
      cloudDatabaseSync.replicateRow('watches', updated as unknown as Record<string, unknown>).catch(() => {});
    }
    return updated;
  }

  updateEventTiming(id: string, startTime?: string | null, endTimeDeadline?: string | null): void {
    const watch = this.getById(id);
    if (!watch) return;
    const nextResConfig = {
      ...watch.resolution_config,
      provider_metadata: {
        ...watch.resolution_config.provider_metadata,
        ...(startTime ? { event_start_time: startTime } : {}),
        ...(endTimeDeadline ? { event_end_time: endTimeDeadline } : {})
      }
    };
    db.prepare(`
      UPDATE watches
      SET resolution_config = ?,
          window_start_date = COALESCE(?, window_start_date),
          detected_deadline = COALESCE(?, detected_deadline)
      WHERE id = ?
    `).run(JSON.stringify(nextResConfig), startTime || null, endTimeDeadline || null, id);
  }

  markClosingSoonNotified(id: string): void {
    db.prepare('UPDATE watches SET closing_soon_notified = 1 WHERE id = ?').run(id);
  }

  updateStatusAfterCheck(params: {
    id: string;
    isOpen: boolean;
    proposedOutcome: number | null;
    snapshotHash: string | null;
    summary: string;
    detectedDeadline?: string | null;
    detectedApplyUrl?: string | null;
    nextPollAfter?: number;
  }): WatchRecord | null {
    const now = new Date().toISOString();
    const current = this.getById(params.id);
    if (!current) return null;

    let nextStatus: WatchStatus = current.status;
    if (params.isOpen) {
      nextStatus = 'triggered_open';
    } else if (params.proposedOutcome === 2) {
      nextStatus = 'expired_closed';
    } else if (current.status === 'triggered_open') {
      nextStatus = 'active_monitoring';
    }

    const triggeredAt = params.isOpen ? current.triggered_at || now : null;
    const pollAfter = params.nextPollAfter ?? current.poll_after;

    db.prepare(`
      UPDATE watches
      SET status = ?,
          proposed_outcome = ?,
          poll_after = ?,
          last_checked_at = ?,
          last_snapshot_hash = ?,
          last_status_summary = ?,
          detected_deadline = COALESCE(?, detected_deadline),
          detected_apply_url = COALESCE(?, detected_apply_url),
          triggered_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      params.proposedOutcome,
      pollAfter,
      now,
      params.snapshotHash,
      params.summary,
      params.detectedDeadline || null,
      params.detectedApplyUrl || null,
      triggeredAt,
      params.id
    );

    const updated = this.getById(params.id);
    if (updated) {
      cloudDatabaseSync.replicateRow('watches', updated as unknown as Record<string, unknown>).catch(() => {});
    }
    return updated;
  }

  updateFields(
    id: string,
    updates: Partial<{
      title: string;
      target_url: string | null;
      secondary_url: string | null;
      condition_text: string;
      window_start_date: string | null;
      window_label: string | null;
      status: WatchStatus;
      is_auto_resolve: boolean;
      poll_after: number;
      notify_channels: NotificationChannelType[];
      recipient_email: string | null;
    }>
  ): WatchRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;

    db.prepare(`
      UPDATE watches
      SET title = ?,
          target_url = ?,
          secondary_url = ?,
          condition_text = ?,
          window_start_date = ?,
          window_label = ?,
          status = ?,
          is_auto_resolve = ?,
          poll_after = ?,
          notify_channels = ?,
          recipient_email = ?
      WHERE id = ?
    `).run(
      updates.title ?? existing.title,
      updates.target_url !== undefined ? updates.target_url : existing.target_url,
      updates.secondary_url !== undefined ? updates.secondary_url : existing.secondary_url,
      updates.condition_text ?? existing.condition_text,
      updates.window_start_date !== undefined ? updates.window_start_date : existing.window_start_date,
      updates.window_label !== undefined ? updates.window_label : existing.window_label,
      updates.status ?? existing.status,
      (updates.is_auto_resolve ?? existing.is_auto_resolve) ? 1 : 0,
      updates.poll_after ?? existing.poll_after,
      JSON.stringify(updates.notify_channels ?? existing.notify_channels),
      updates.recipient_email !== undefined ? updates.recipient_email : existing.recipient_email,
      id
    );

    const updated = this.getById(id);
    if (updated) {
      cloudDatabaseSync.replicateRow('watches', updated as unknown as Record<string, unknown>).catch(() => {});
    }
    return updated;
  }

  delete(id: string): boolean {
    db.prepare('DELETE FROM check_logs WHERE watch_id = ?').run(id);
    const res = db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    cloudDatabaseSync.deleteRow('watches', id).catch(() => {});
    return Number(res.changes) > 0;
  }

  insertCheckLog(entry: Omit<CheckLogRecord, 'id' | 'checked_at'>): CheckLogRecord {
    const id = 'chk_' + crypto.randomUUID().slice(0, 8);
    const checkedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO check_logs (
        id, watch_id, checked_at, http_status, is_open, confidence, summary, extracted_snippet,
        page_changed, oracle_name, cache_hit, entity_validated, next_poll_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.watch_id,
      checkedAt,
      entry.http_status,
      entry.is_open ? 1 : 0,
      entry.confidence,
      entry.summary,
      entry.extracted_snippet,
      entry.page_changed ? 1 : 0,
      entry.oracle_name || 'web_portal',
      entry.cache_hit ? 1 : 0,
      entry.entity_validated !== false ? 1 : 0,
      entry.next_poll_after ?? null
    );

    const logRecord: CheckLogRecord = {
      id,
      checked_at: checkedAt,
      ...entry
    };
    cloudDatabaseSync.replicateRow('check_logs', logRecord as unknown as Record<string, unknown>).catch(() => {});
    return logRecord;
  }

  listCheckLogs(watchId?: string, limit = 30): CheckLogRecord[] {
    const rows = (
      watchId
        ? db.prepare('SELECT * FROM check_logs WHERE watch_id = ? ORDER BY checked_at DESC LIMIT ?').all(watchId, limit)
        : db.prepare('SELECT * FROM check_logs ORDER BY checked_at DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: String(r.id),
      watch_id: String(r.watch_id),
      checked_at: String(r.checked_at),
      http_status: r.http_status !== null ? Number(r.http_status) : null,
      is_open: Boolean(r.is_open),
      confidence: Number(r.confidence),
      summary: String(r.summary),
      extracted_snippet: r.extracted_snippet ? String(r.extracted_snippet) : null,
      page_changed: Boolean(r.page_changed),
      oracle_name: r.oracle_name ? String(r.oracle_name) : 'web_portal',
      cache_hit: Boolean(r.cache_hit),
      entity_validated: Boolean(r.entity_validated ?? 1),
      next_poll_after:
        r.next_poll_after !== null && r.next_poll_after !== undefined ? Number(r.next_poll_after) : undefined
    }));
  }
}

export const watchRepository = new WatchRepository();
