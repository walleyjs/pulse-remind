import { privacyMinimizer } from '../../pkg/privacy/minimizer.ts';
import { watchRepository, WatchRepository } from './repository.ts';
import type { CheckLogRecord, CreateWatchInput, WatchRecord } from './model.ts';

export class WatchService {
  private readonly repo: WatchRepository;

  constructor(repo: WatchRepository = watchRepository) {
    this.repo = repo;
  }

  createWatch(input: CreateWatchInput): WatchRecord {
    const minimized = privacyMinimizer.sanitizeAndDistillContext(input.chat_context);
    const existingMeta = input.resolution_config?.provider_metadata || {};

    return this.repo.create({
      ...input,
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
    });
  }

  listWatches(statusFilter?: string): WatchRecord[] {
    return this.repo.list(statusFilter);
  }

  getWatchById(id: string): WatchRecord | null {
    return this.repo.getById(id);
  }

  getWatchesReadyForResolution(nowUnix?: number): WatchRecord[] {
    return this.repo.getReadyForResolution(nowUnix);
  }

  updateWatchFields(id: string, updates: Parameters<WatchRepository['updateFields']>[1]): WatchRecord | null {
    return this.repo.updateFields(id, updates);
  }

  deleteWatch(id: string): boolean {
    return this.repo.delete(id);
  }

  listCheckLogs(watchId?: string, limit = 30): CheckLogRecord[] {
    return this.repo.listCheckLogs(watchId, limit);
  }

  claimSubscriberToken(
    token: string,
    params: {
      recipient_email?: string;
      notify_channels?: WatchRecord['notify_channels'];
      ntfy_topic?: string;
    }
  ): WatchRecord | null {
    return this.repo.claimSubscriberToken(token, params);
  }
}

export const watchService = new WatchService();
