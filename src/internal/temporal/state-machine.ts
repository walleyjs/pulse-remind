import type { WatchStatus } from '../watch/model.ts';

/**
 * Universal Event Temporal State Machine
 * Directed lifecycle transitions:
 * HIBERNATING -> EXPONENTIAL_APPROACH -> ACTIVE_SAMPLING -> TRIGGERED -> COOLED_DOWN -> ARCHIVED
 */
export const VALID_TRANSITIONS: Record<WatchStatus, WatchStatus[]> = {
  hibernating: ['exponential_approach', 'active_sampling', 'active_monitoring', 'paused', 'config_error'],
  exponential_approach: ['active_sampling', 'triggered', 'triggered_open', 'paused', 'config_error', 'hibernating'],
  active_sampling: ['triggered', 'triggered_open', 'cooled_down', 'expired_closed', 'paused', 'config_error', 'exponential_approach'],
  active_monitoring: ['triggered', 'triggered_open', 'cooled_down', 'expired_closed', 'paused', 'config_error', 'hibernating'],
  triggered: ['cooled_down', 'archived', 'paused'],
  triggered_open: ['cooled_down', 'archived', 'paused', 'active_sampling', 'active_monitoring'],
  proposed_open: ['triggered', 'triggered_open', 'active_sampling', 'active_monitoring', 'config_error'],
  cooled_down: ['archived', 'hibernating', 'exponential_approach', 'active_sampling'],
  expired_closed: ['archived', 'hibernating', 'active_sampling'],
  archived: ['hibernating', 'active_sampling'],
  config_error: ['hibernating', 'active_sampling', 'active_monitoring', 'paused'],
  paused: ['hibernating', 'exponential_approach', 'active_sampling', 'active_monitoring', 'config_error']
};

export function canTransition(current: WatchStatus, target: WatchStatus): boolean {
  if (current === target) return true;
  const allowed = VALID_TRANSITIONS[current] || [];
  return allowed.includes(target);
}

export function assertValidTransition(current: WatchStatus, target: WatchStatus): void {
  if (!canTransition(current, target)) {
    throw new Error(`Invalid event state transition: ${current} -> ${target}`);
  }
}
