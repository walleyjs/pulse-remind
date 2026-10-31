import type { CheckLogRecord, OracleResponseRecord, WatchRecord } from '../watch/model.ts';
import type { NotificationRecord } from '../notification/model.ts';
import type { CommerceEvaluationResult } from './predicates.ts';

export interface EvaluationResult {
  httpStatus: number | null;
  isOpen: boolean;
  /**
   * Octopus DecisionMaker outcome convention:
   * - 1 = YES (Applications are OPEN)
   * - 2 = NO  (Deadline passed / permanently closed for cycle)
   * - null = Pre-opening / not yet resolved
   */
  outcome: 1 | 2 | null;
  confidence: number;
  summary: string;
  extractedSnippet: string | null;
  snapshotHash: string | null;
  pageChanged: boolean;
  detectedDeadline: string | null;
  detectedOpenDate: string | null;
  detectedApplyUrl: string | null;
  oracleRecord: OracleResponseRecord | null;
  cacheHit: boolean;
  entityValidated: boolean;
  commerceEvaluation?: CommerceEvaluationResult | null;
}

/**
 * Adapted from Octopus API `DecisionMaker` trait (`src/internal/resolution/mod.rs`)
 */
export interface DecisionMakerAdapter {
  readonly oracleName: string;
  resolve(watch: WatchRecord, bypassCache?: boolean): Promise<EvaluationResult>;
}

export interface WatchCheckOutcome {
  watch: WatchRecord;
  evaluation: EvaluationResult;
  checkLog: CheckLogRecord;
  notificationsDispatched: NotificationRecord[];
  newlyTriggered: boolean;
  errorType?: 'entity_mismatch' | 'transient_backoff';
}
