import { config } from '../../config/index.ts';
import { resolveTimeframeWindow } from '../extractor/timeframe.ts';
import { notificationService, NotificationService } from '../notification/service.ts';
import type { NotificationRecord } from '../notification/model.ts';
import { watchRepository, WatchRepository } from '../watch/repository.ts';
import { getAdapterForWatch } from './adapters/index.ts';
import type { WatchCheckOutcome } from './types.ts';
import { normalizeCanonicalUrl } from './validator.ts';
import { calculateHazardRateSchedule } from '../temporal/hazard-rate.ts';
import { verifyProbeConsensus } from './consensus.ts';

export class ResolutionEngine {
  private readonly watchRepo: WatchRepository;
  private readonly notifications: NotificationService;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    watchRepo: WatchRepository = watchRepository,
    notifications: NotificationService = notificationService
  ) {
    this.watchRepo = watchRepo;
    this.notifications = notifications;
  }

  async runWatchCheck(
    watchId: string,
    options: { bypassCache?: boolean; tenantId?: string } = {}
  ): Promise<WatchCheckOutcome | null> {
    const watch = this.watchRepo.getById(watchId, options.tenantId);
    if (!watch) return null;

    const wasAlreadyOpen = watch.status === 'triggered_open';
    const currentUnix = Math.floor(Date.now() / 1000);
    const adapter = getAdapterForWatch(watch);

    try {
      const evaluation = await adapter.resolve(watch, options.bypassCache ?? false);

      // 1. Save OracleResponseRecord audit trail (Octopus engine.rs:48-52)
      if (evaluation.oracleRecord) {
        this.watchRepo.addOracleResponse(watch.id, evaluation.oracleRecord);
      }

      // 2. Auto-learn Event Timing & Deadline from Oracle Response (Octopus engine.rs:71-95)
      let learnedStart: string | null = null;
      if (!watch.window_start_date && evaluation.detectedOpenDate) {
        learnedStart = resolveTimeframeWindow(evaluation.detectedOpenDate).window_start_date;
      }
      if (learnedStart || (!watch.detected_deadline && evaluation.detectedDeadline)) {
        this.watchRepo.updateEventTiming(watch.id, learnedStart, evaluation.detectedDeadline);
      }

      // 3. Adaptive Hazard-Rate Schedule optimization for `poll_after`
      let nextPollAfter = currentUnix + watch.check_interval_minutes * 60;
      const effectiveStartDate = learnedStart || watch.window_start_date;
      if (effectiveStartDate) {
        const startUnix = Math.floor(new Date(effectiveStartDate).getTime() / 1000);
        if (!isNaN(startUnix)) {
          const sched = calculateHazardRateSchedule(startUnix, currentUnix, watch.check_interval_minutes);
          nextPollAfter = sched.pollAfterUnix;
        }
      }

      // 4. Anti-Flap Multi-Probe Consensus Verification on state transitions
      let finalEvaluation = evaluation;
      if (evaluation.isOpen !== wasAlreadyOpen && watch.target_url && !options.bypassCache) {
        try {
          const confirmEval = await adapter.resolve(watch, true);
          const consensus = verifyProbeConsensus(evaluation, confirmEval);
          if (!consensus.confirmed) {
            const backoffPoll = currentUnix + 30;
            this.watchRepo.updatePollAfter(watch.id, backoffPoll, consensus.reason, watch.tenant_id);
            const checkLog = this.watchRepo.insertCheckLog(
              {
                watch_id: watch.id,
                http_status: evaluation.httpStatus,
                is_open: wasAlreadyOpen,
                confidence: consensus.confidence,
                summary: consensus.reason,
                extracted_snippet: null,
                page_changed: false,
                oracle_name: adapter.oracleName,
                cache_hit: false,
                entity_validated: true,
                next_poll_after: backoffPoll
              },
              watch.tenant_id
            );
            return {
              watch,
              evaluation: {
                ...evaluation,
                isOpen: wasAlreadyOpen,
                confidence: consensus.confidence,
                summary: consensus.reason
              },
              checkLog,
              notificationsDispatched: [],
              newlyTriggered: false
            };
          }
          finalEvaluation = {
            ...evaluation,
            confidence: consensus.confidence,
            summary: `${evaluation.summary} [Consensus Verified]`
          };
        } catch {
          // If secondary probe fails, fall back to primary evaluation
        }
      }

      const checkLog = this.watchRepo.insertCheckLog({
        watch_id: watch.id,
        http_status: finalEvaluation.httpStatus,
        is_open: finalEvaluation.isOpen,
        confidence: finalEvaluation.confidence,
        summary: finalEvaluation.summary,
        extracted_snippet: finalEvaluation.extractedSnippet,
        page_changed: finalEvaluation.pageChanged,
        oracle_name: finalEvaluation.oracleRecord?.oracle_name || adapter.oracleName,
        cache_hit: finalEvaluation.cacheHit,
        entity_validated: finalEvaluation.entityValidated,
        next_poll_after: nextPollAfter
      }, watch.tenant_id);

      const updatedWatch =
        this.watchRepo.updateStatusAfterCheck({
          id: watch.id,
          isOpen: finalEvaluation.isOpen,
          proposedOutcome: finalEvaluation.outcome,
          snapshotHash: finalEvaluation.snapshotHash,
          summary: finalEvaluation.summary,
          detectedDeadline: finalEvaluation.detectedDeadline,
          detectedApplyUrl: finalEvaluation.detectedApplyUrl,
          nextPollAfter
        }) || watch;

      let notificationsDispatched: NotificationRecord[] = [];
      const newlyTriggered = finalEvaluation.isOpen && !wasAlreadyOpen;

      if (newlyTriggered) {
        notificationsDispatched = await this.notifications.dispatchOpenNotifications(
          updatedWatch,
          finalEvaluation
        );
      }

      // 4. Closing-Soon Deadline Notification check (Octopus `closing_soon_notified`)
      if (
        updatedWatch.status === 'triggered_open' &&
        updatedWatch.detected_deadline &&
        !updatedWatch.closing_soon_notified
      ) {
        const deadlineMs = new Date(updatedWatch.detected_deadline).getTime();
        const daysUntilDeadline = (deadlineMs - Date.now()) / (1000 * 60 * 60 * 24);
        if (
          !isNaN(daysUntilDeadline) &&
          daysUntilDeadline > 0 &&
          daysUntilDeadline <= config.resolution.closingSoonDaysThreshold
        ) {
          this.watchRepo.markClosingSoonNotified(updatedWatch.id);
          this.notifications.insertInAppAlert({
            watchId: updatedWatch.id,
            watchTitle: updatedWatch.title,
            recipient: 'Dashboard Inbox',
            subject: `⏳ CLOSING SOON: ${updatedWatch.title} deadline is ${updatedWatch.detected_deadline}`,
            message: `Reminder: Your tracked opportunity "${updatedWatch.title}" closes on ${updatedWatch.detected_deadline} (${Math.ceil(daysUntilDeadline)} days remaining).`,
            previewUrl: updatedWatch.detected_apply_url || updatedWatch.target_url,
            tenantId: updatedWatch.tenant_id
          });
        }
      }

      return {
        watch: updatedWatch,
        evaluation,
        checkLog,
        notificationsDispatched,
        newlyTriggered
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isEntityMismatch = errMsg.toLowerCase().includes('entity mismatch');

      if (isEntityMismatch) {
        const disabledWatch =
          this.watchRepo.disableAutoResolveOnEntityMismatch(watch.id, errMsg, watch.tenant_id) || watch;

        const checkLog = this.watchRepo.insertCheckLog({
          watch_id: watch.id,
          http_status: 200,
          is_open: false,
          confidence: 0,
          summary: errMsg,
          extracted_snippet: null,
          page_changed: false,
          oracle_name: adapter.oracleName,
          cache_hit: false,
          entity_validated: false,
          next_poll_after: currentUnix + config.resolution.entityMismatchBackoffSeconds
        }, watch.tenant_id);

        const alertNotif = this.notifications.insertInAppAlert({
          watchId: watch.id,
          watchTitle: watch.title,
          recipient: 'Config Integrity Guard',
          subject: `⚠️ Auto-Resolution Paused (Entity Mismatch): ${watch.title}`,
          message: errMsg,
          previewUrl: watch.target_url,
          tenantId: watch.tenant_id
        });

        return {
          watch: disabledWatch,
          evaluation: {
            httpStatus: 200,
            isOpen: false,
            outcome: null,
            confidence: 0,
            summary: errMsg,
            extractedSnippet: null,
            snapshotHash: watch.last_snapshot_hash,
            pageChanged: false,
            detectedDeadline: null,
            detectedOpenDate: null,
            detectedApplyUrl: null,
            oracleRecord: null,
            cacheHit: false,
            entityValidated: false
          },
          checkLog,
          notificationsDispatched: [alertNotif],
          newlyTriggered: false,
          errorType: 'entity_mismatch'
        };
      }

      // Transient error: NEVER disable auto_resolve, NEVER spam notifications, back off by 15 minutes
      const backoffPollAfter = currentUnix + config.resolution.transientBackoffSeconds;
      const backoffSummary = `Transient oracle/network error (${errMsg}). Auto-resolve remains active; backed off poll_after by 15m.`;
      this.watchRepo.updatePollAfter(watch.id, backoffPollAfter, backoffSummary, watch.tenant_id);

      const checkLog = this.watchRepo.insertCheckLog({
        watch_id: watch.id,
        http_status: null,
        is_open: false,
        confidence: 0,
        summary: backoffSummary,
        extracted_snippet: null,
        page_changed: false,
        oracle_name: adapter.oracleName,
        cache_hit: false,
        entity_validated: true,
        next_poll_after: backoffPollAfter
      }, watch.tenant_id);

      const updatedWatch = this.watchRepo.getById(watch.id) || watch;

      return {
        watch: updatedWatch,
        evaluation: {
          httpStatus: null,
          isOpen: false,
          outcome: null,
          confidence: 0,
          summary: backoffSummary,
          extractedSnippet: null,
          snapshotHash: watch.last_snapshot_hash,
          pageChanged: false,
          detectedDeadline: null,
          detectedOpenDate: null,
          detectedApplyUrl: null,
          oracleRecord: null,
          cacheHit: false,
          entityValidated: true
        },
        checkLog,
        notificationsDispatched: [],
        newlyTriggered: false,
        errorType: 'transient_backoff'
      };
    }
  }

  async runCycleWithMetrics(forceAll = false): Promise<{
    outcomes: WatchCheckOutcome[];
    totalWatchesEvaluated: number;
    uniqueCanonicalTargets: number;
    liveOracleScrapes: number;
    cacheHits: number;
    notificationsDispatched: number;
  }> {
    const dueWatches = forceAll
      ? this.watchRepo.list()
      : this.watchRepo.getReadyForResolution();
    const now = new Date();
    const outcomes: WatchCheckOutcome[] = [];

    // Group eligible watches by normalized canonical URL so N subscribers share 1 scrape per target
    const canonicalGroups = new Map<string, typeof dueWatches>();

    for (const w of dueWatches) {
      if (w.status === 'paused' || (!forceAll && !w.is_auto_resolve)) continue;

      if (w.status === 'hibernating' && w.window_start_date) {
        const start = new Date(w.window_start_date);
        const diffDays = (start.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays <= config.resolution.preWindowWakeDays) {
          this.watchRepo.updateFields(w.id, { status: 'active_monitoring' });
        } else if (!forceAll) {
          continue;
        }
      }

      const canonicalKey = normalizeCanonicalUrl(w.target_url) || `no_url::${w.id}`;
      const group = canonicalGroups.get(canonicalKey) || [];
      group.push(w);
      canonicalGroups.set(canonicalKey, group);
    }

    let liveOracleScrapes = 0;
    let cacheHits = 0;
    let notificationsDispatched = 0;

    for (const [, watchesInGroup] of canonicalGroups) {
      if (watchesInGroup.length === 0) continue;
      // 1. Probe the target ONCE for this canonical target group
      const primary = watchesInGroup[0];
      const outcome = await this.runWatchCheck(primary.id);
      if (!outcome) continue;

      outcomes.push(outcome);
      if (outcome.evaluation.cacheHit) {
        cacheHits++;
      } else {
        liveOracleScrapes++;
      }
      notificationsDispatched += outcome.notificationsDispatched.length;

      // 2. Multiplexed Fan-Out: replicate state transition and notifications to all other subscribers in group
      for (let i = 1; i < watchesInGroup.length; i++) {
        cacheHits++;
        const sub = watchesInGroup[i];
        const updated = this.watchRepo.updateStatusAfterCheck({
          id: sub.id,
          isOpen: outcome.evaluation.isOpen,
          proposedOutcome: outcome.evaluation.outcome,
          snapshotHash: outcome.evaluation.snapshotHash,
          summary: outcome.evaluation.summary,
          detectedDeadline: outcome.evaluation.detectedDeadline,
          detectedApplyUrl: outcome.evaluation.detectedApplyUrl,
          nextPollAfter: outcome.watch.poll_after,
          tenant_id: sub.tenant_id
        });

        let subNotifs: NotificationRecord[] = [];
        if (outcome.newlyTriggered && updated) {
          subNotifs = await this.notifications.dispatchOpenNotifications(updated, outcome.evaluation);
          notificationsDispatched += subNotifs.length;
        }

        outcomes.push({
          watch: updated || sub,
          evaluation: {
            ...outcome.evaluation,
            cacheHit: true
          },
          checkLog: outcome.checkLog,
          notificationsDispatched: subNotifs,
          newlyTriggered: outcome.newlyTriggered
        });
      }
    }

    return {
      outcomes,
      totalWatchesEvaluated: outcomes.length,
      uniqueCanonicalTargets: canonicalGroups.size,
      liveOracleScrapes,
      cacheHits,
      notificationsDispatched
    };
  }

  async runCycle(forceAll = false): Promise<WatchCheckOutcome[]> {
    const res = await this.runCycleWithMetrics(forceAll);
    return res.outcomes;
  }

  startScheduler(pollIntervalMs = config.resolution.schedulerIntervalMs): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      this.runCycle(false).catch((err) => {
        console.error('[PulseRemind ResolutionEngine Error]:', err);
      });
    }, pollIntervalMs);
    if (this.schedulerTimer.unref) {
      this.schedulerTimer.unref();
    }

    // If running on Render (or any sleep-tier host with RENDER_EXTERNAL_URL / PUBLIC_APP_URL),
    // self-ping /api/health every 13 minutes so the load balancer sees active traffic before the 15m idle cutoff.
    if (config.cloud.renderExternalUrl && !this.keepAliveTimer) {
      const pingUrl = `${config.cloud.renderExternalUrl.replace(/\/$/, '')}/api/health`;
      this.keepAliveTimer = setInterval(() => {
        fetch(pingUrl, { headers: { 'User-Agent': 'PulseRemind-KeepAlive/1.0' } }).catch(() => {});
      }, config.cloud.keepAliveIntervalMs);
      if (this.keepAliveTimer.unref) {
        this.keepAliveTimer.unref();
      }
    }
  }

  startBackgroundScheduler(pollIntervalMs = config.resolution.schedulerIntervalMs): void {
    this.startScheduler(pollIntervalMs);
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}

export const resolutionEngine = new ResolutionEngine();
