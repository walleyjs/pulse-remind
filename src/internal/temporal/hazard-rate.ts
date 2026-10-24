import crypto from 'node:crypto';
import type { WatchStatus } from '../watch/model.ts';

export interface HazardRateSchedule {
  status: WatchStatus;
  pollAfterUnix: number;
  intervalSeconds: number;
  phaseLabel: string;
}

/**
 * Calculates adaptive temporal hazard-rate sampling compression with decorrelated jitter.
 * Polling dynamically accelerates from days/hours down to high-frequency bursts as T_event nears.
 */
export function calculateHazardRateSchedule(
  targetEventUnix: number | null,
  currentUnix = Math.floor(Date.now() / 1000),
  defaultIntervalMinutes = 60
): HazardRateSchedule {
  if (!targetEventUnix || isNaN(targetEventUnix)) {
    const fallbackSec = defaultIntervalMinutes * 60;
    return {
      status: 'active_sampling',
      pollAfterUnix: currentUnix + fallbackSec,
      intervalSeconds: fallbackSec,
      phaseLabel: 'default_periodic'
    };
  }

  const deltaSeconds = targetEventUnix - currentUnix;

  // 1. Far Future (> 21 days): Hibernation mode (poll every 7 days)
  if (deltaSeconds > 21 * 86400) {
    const intervalSeconds = 7 * 86400;
    const jitter = Math.floor(intervalSeconds * 0.05); // +/- 5%
    const jitteredInterval = intervalSeconds + crypto.randomInt(-jitter, jitter + 1);
    const pollAfterUnix = Math.min(currentUnix + jitteredInterval, targetEventUnix - 20 * 86400);

    return {
      status: 'hibernating',
      pollAfterUnix,
      intervalSeconds: jitteredInterval,
      phaseLabel: 'pre_window_hibernation'
    };
  }

  // 2. Medium Term (3 days to 21 days): Exponential approach phase (interval scales from 24h down to 2h)
  if (deltaSeconds > 3 * 86400) {
    const fraction = (deltaSeconds - 3 * 86400) / (18 * 86400); // 0 to 1
    const baseSec = Math.floor(7200 + fraction * (86400 - 7200)); // 2h to 24h
    const jitter = Math.floor(baseSec * 0.1);
    const jitteredInterval = baseSec + crypto.randomInt(-jitter, jitter + 1);

    return {
      status: 'exponential_approach',
      pollAfterUnix: currentUnix + jitteredInterval,
      intervalSeconds: jitteredInterval,
      phaseLabel: 'exponential_approach'
    };
  }

  // 3. Near Term (0 to 3 days): High-frequency active sampling with hyperbolic compression
  if (deltaSeconds > 0) {
    let baseSec: number;
    if (deltaSeconds > 86400) {
      // 1-3 days out: 30m - 60m
      baseSec = 1800 + Math.floor((deltaSeconds - 86400) / (2 * 86400) * 1800);
    } else if (deltaSeconds > 3600 * 2) {
      // 2h to 24h out: 5m - 30m
      baseSec = 300 + Math.floor((deltaSeconds - 7200) / (86400 - 7200) * 1500);
    } else if (deltaSeconds > 600) {
      // 10m to 2h out: 60s - 300s
      baseSec = 60 + Math.floor((deltaSeconds - 600) / (7200 - 600) * 240);
    } else {
      // < 10m out: sub-minute burst probing (30s)
      baseSec = 30;
    }

    const jitter = Math.max(2, Math.floor(baseSec * 0.1));
    const jitteredInterval = Math.max(15, baseSec + crypto.randomInt(-jitter, jitter + 1));

    return {
      status: 'active_sampling',
      pollAfterUnix: currentUnix + jitteredInterval,
      intervalSeconds: jitteredInterval,
      phaseLabel: 'active_sampling_hyperbolic'
    };
  }

  // 4. Past / Target arrived: Event active or cooled down
  const postInterval = 300; // 5 minutes post-target window
  return {
    status: 'active_sampling',
    pollAfterUnix: currentUnix + postInterval,
    intervalSeconds: postInterval,
    phaseLabel: 'event_window_arrived'
  };
}
