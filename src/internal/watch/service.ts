import { privacyMinimizer } from '../../pkg/privacy/minimizer.ts';
import { watchRepository, WatchRepository } from './repository.ts';
import { DEFAULT_TENANT_ID } from '../../pkg/tenant/tenant.ts';
import type { CheckLogRecord, CreateWatchInput, WatchRecord } from './model.ts';

export class WatchService {
  private readonly repo: WatchRepository;

  constructor(repo: WatchRepository = watchRepository) {
    this.repo = repo;
  }

  createWatch(input: CreateWatchInput, tenantId = DEFAULT_TENANT_ID): WatchRecord {
    const effectiveTenantId = input.tenant_id || tenantId;
    const minimized = privacyMinimizer.sanitizeAndDistillContext(input.chat_context);
    const existingMeta = input.resolution_config?.provider_metadata || {};

    return this.repo.create(
      {
        ...input,
        tenant_id: effectiveTenantId,
        chat_context: minimized.sanitizedNote,
        resolution_config: {
          ...input.resolution_config,
          provider_metadata: {
            ...existingMeta,
            subscriber_token: existingMeta.subscriber_token || minimized.subscriberToken,
            claim_url: existingMeta.claim_url || minimized.claimUrl,
            pii_redacted_count: String(minimized.redactedCount),
            action_checklist: JSON.stringify(minimized.actionItems)
          }
        }
      },
      effectiveTenantId
    );
  }

  listWatches(statusFilter?: string, tenantId?: string): WatchRecord[] {
    return this.repo.list(statusFilter, tenantId);
  }

  getWatchById(id: string, tenantId?: string): WatchRecord | null {
    return this.repo.getById(id, tenantId);
  }

  getWatchesReadyForResolution(nowUnix?: number): WatchRecord[] {
    return this.repo.getReadyForResolution(nowUnix);
  }

  updateWatchFields(
    id: string,
    updates: Parameters<WatchRepository['updateFields']>[1],
    tenantId?: string
  ): WatchRecord | null {
    return this.repo.updateFields(id, updates, tenantId);
  }

  deleteWatch(id: string, tenantId?: string): boolean {
    return this.repo.delete(id, tenantId);
  }

  toggleChecklistItem(
    watchId: string,
    itemText: string,
    completed: boolean,
    tenantId?: string
  ): WatchRecord | null {
    const watch = this.getWatchById(watchId, tenantId);
    if (!watch) return null;
    const meta = { ...(watch.resolution_config?.provider_metadata || {}) };
    const completedItems = new Set<string>(
      Array.isArray(meta.checklist_completed) ? meta.checklist_completed : []
    );
    if (completed) {
      completedItems.add(itemText);
    } else {
      completedItems.delete(itemText);
    }
    meta.checklist_completed = Array.from(completedItems);
    const updatedResolutionConfig = {
      ...(watch.resolution_config || {}),
      provider_metadata: meta
    };
    return this.updateWatchFields(
      watchId,
      { resolution_config: updatedResolutionConfig as any },
      watch.tenant_id
    );
  }

  listCheckLogs(watchId?: string, limit = 30, tenantId?: string): CheckLogRecord[] {
    return this.repo.listCheckLogs(watchId, limit, tenantId);
  }

  claimSubscriberToken(
    token: string,
    params: {
      recipient_email?: string;
      notify_channels?: WatchRecord['notify_channels'];
      ntfy_topic?: string;
    },
    tenantId?: string
  ): WatchRecord | null {
    return this.repo.claimSubscriberToken(token, params, tenantId);
  }

  bindNotificationDestination(params: {
    recipient_email: string;
    watch_id?: string;
    notify_channels?: WatchRecord['notify_channels'];
    ntfy_topic?: string;
    save_as_default?: boolean;
    tenant_id?: string;
  }): WatchRecord[] {
    return this.repo.bindNotificationDestination(params);
  }

  findByCanonicalUrlKey(canonicalUrlKey: string): WatchRecord[] {
    return this.repo.findByCanonicalUrlKey(canonicalUrlKey);
  }
}

export const watchService = new WatchService();
