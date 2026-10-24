/**
 * Lightweight, zero-dependency RFC 5545 RRULE evaluator.
 * Evaluates FREQ=DAILY, WEEKLY, MONTHLY, YEARLY, INTERVAL, BYDAY, BYMONTHDAY, UNTIL.
 */

export interface ParsedRRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay?: string[]; // ['MO', 'TU', ...]
  byMonthDay?: number[];
  until?: string; // ISO date string
  count?: number;
}

const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6
};

export function parseRRuleString(rruleStr: string): ParsedRRule {
  const parts = rruleStr.replace(/^RRULE:/i, '').split(';');
  const result: ParsedRRule = {
    freq: 'DAILY',
    interval: 1
  };

  for (const part of parts) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    const key = k.trim().toUpperCase();
    const val = v.trim();

    if (key === 'FREQ') {
      const f = val.toUpperCase();
      if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(f)) {
        result.freq = f as ParsedRRule['freq'];
      }
    } else if (key === 'INTERVAL') {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num > 0) result.interval = num;
    } else if (key === 'BYDAY') {
      result.byDay = val.toUpperCase().split(',').map((d) => d.trim());
    } else if (key === 'BYMONTHDAY') {
      result.byMonthDay = val.split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));
    } else if (key === 'UNTIL') {
      result.until = val;
    } else if (key === 'COUNT') {
      const c = parseInt(val, 10);
      if (!isNaN(c)) result.count = c;
    }
  }

  return result;
}

export function computeNextRRuleOccurrence(
  rruleStr: string,
  startDateIso: string,
  fromUnix = Math.floor(Date.now() / 1000)
): { nextUnix: number; nextIso: string } | null {
  const rule = parseRRuleString(rruleStr);
  const start = new Date(startDateIso);
  if (isNaN(start.getTime())) return null;

  let current = new Date(start);
  const fromMs = fromUnix * 1000;

  // If start is already in the future, return start
  if (current.getTime() > fromMs) {
    return {
      nextUnix: Math.floor(current.getTime() / 1000),
      nextIso: current.toISOString()
    };
  }

  const untilMs = rule.until ? new Date(rule.until).getTime() : Infinity;
  let iterations = 0;
  const maxIterations = 500;

  while (current.getTime() <= fromMs && iterations++ < maxIterations) {
    if (rule.freq === 'DAILY') {
      current.setDate(current.getDate() + rule.interval);
    } else if (rule.freq === 'WEEKLY') {
      if (rule.byDay && rule.byDay.length > 0) {
        // Advance day by day until match
        do {
          current.setDate(current.getDate() + 1);
          const dayName = Object.keys(DAY_MAP).find((d) => DAY_MAP[d] === current.getDay());
          if (dayName && rule.byDay.includes(dayName)) break;
        } while (iterations++ < maxIterations);
      } else {
        current.setDate(current.getDate() + 7 * rule.interval);
      }
    } else if (rule.freq === 'MONTHLY') {
      if (rule.byMonthDay && rule.byMonthDay.length > 0) {
        current.setMonth(current.getMonth() + rule.interval);
        current.setDate(rule.byMonthDay[0]);
      } else {
        current.setMonth(current.getMonth() + rule.interval);
      }
    } else if (rule.freq === 'YEARLY') {
      current.setFullYear(current.getFullYear() + rule.interval);
    }

    if (current.getTime() > untilMs) {
      return null;
    }
  }

  if (current.getTime() <= fromMs || current.getTime() > untilMs) {
    return null;
  }

  return {
    nextUnix: Math.floor(current.getTime() / 1000),
    nextIso: current.toISOString()
  };
}

export function evaluateRRule(
  rruleStr: string,
  startDate: Date = new Date(),
  count = 5
): Date[] {
  const dates: Date[] = [];
  let fromUnix = Math.floor(startDate.getTime() / 1000) - 1;
  const startIso = startDate.toISOString();
  for (let i = 0; i < count; i++) {
    const next = computeNextRRuleOccurrence(rruleStr, startIso, fromUnix);
    if (!next) break;
    dates.push(new Date(next.nextUnix * 1000));
    fromUnix = next.nextUnix;
  }
  return dates;
}
