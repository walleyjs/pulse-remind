export interface TimeframeResolution {
  window_start_date: string;
  window_label: string;
  exact_utc_iso?: string;
}

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

/**
 * Resolves conversational timeframe expressions ("end of this month", "early next year",
 * "next Friday", "in 3 days", "November 15, 2026 23:59 AoE", ISO timestamps, etc.)
 * against a pinned reference clock into concrete ISO dates, exact UTC timestamps, and human labels.
 */
export function resolveTimeframeWindow(
  text: string,
  referenceDate = new Date('2026-10-18T12:00:00Z')
): TimeframeResolution {
  const clean = (text || '').trim();
  const lower = clean.toLowerCase();
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();

  // 1. Check AoE ("Anywhere on Earth" = UTC-12) deadline syntax, e.g. "November 15, 2026 23:59 AoE" or "2026-11-15 23:59 AoE"
  const aoeNamedMatch = clean.match(
    /\b([A-Za-z]+)\s+(\d{1,2}),?\s+(202\d|203\d)(?:\s+(?:at\s+)?(\d{1,2}):(\d{2}))?\s*AoE\b/i
  );
  if (aoeNamedMatch) {
    const mIdx = MONTH_INDEX[aoeNamedMatch[1].toLowerCase()];
    if (mIdx !== undefined) {
      const day = Number(aoeNamedMatch[2]);
      const yr = Number(aoeNamedMatch[3]);
      const hh = aoeNamedMatch[4] !== undefined ? Number(aoeNamedMatch[4]) : 23;
      const mm = aoeNamedMatch[5] !== undefined ? Number(aoeNamedMatch[5]) : 59;
      // AoE is UTC-12, so UTC = local + 12 hours
      const utcMs = Date.UTC(yr, mIdx, day, hh + 12, mm, 0);
      const utcDate = new Date(utcMs);
      const localDateStr = `${yr}-${String(mIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return {
        window_start_date: localDateStr,
        window_label: `${aoeNamedMatch[1]} ${day}, ${yr} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} AoE (UTC-12)`,
        exact_utc_iso: utcDate.toISOString()
      };
    }
  }

  const aoeIsoMatch = clean.match(
    /\b(202\d-\d{2}-\d{2})(?:[T\s](\d{1,2}):(\d{2}))?\s*AoE\b/i
  );
  if (aoeIsoMatch) {
    const [yr, mo, dy] = aoeIsoMatch[1].split('-').map(Number);
    const hh = aoeIsoMatch[2] !== undefined ? Number(aoeIsoMatch[2]) : 23;
    const mm = aoeIsoMatch[3] !== undefined ? Number(aoeIsoMatch[3]) : 59;
    const utcDate = new Date(Date.UTC(yr, mo - 1, dy, hh + 12, mm, 0));
    return {
      window_start_date: aoeIsoMatch[1],
      window_label: `${aoeIsoMatch[1]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} AoE (UTC-12)`,
      exact_utc_iso: utcDate.toISOString()
    };
  }

  // 2. Explicit ISO date or timestamp (e.g. "2026-11-20" or "2026-11-20T18:00:00Z")
  const isoMatch = clean.match(/\b(202\d-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?))?\b/);
  if (isoMatch) {
    const datePart = isoMatch[1];
    const fullIso = isoMatch[2] ? `${datePart}T${isoMatch[2]}` : `${datePart}T09:00:00Z`;
    const parsed = new Date(fullIso);
    return {
      window_start_date: datePart,
      window_label: `Scheduled (${datePart})`,
      exact_utc_iso: !isNaN(parsed.getTime()) ? parsed.toISOString() : undefined
    };
  }

  // 3. Relative "in N days" or "tomorrow"
  const inDaysMatch = lower.match(/\bin\s+(\d{1,3})\s+days?\b/);
  if (inDaysMatch) {
    const days = Number(inDaysMatch[1]);
    const target = new Date(referenceDate.getTime() + days * 86400 * 1000);
    const dateStr = target.toISOString().slice(0, 10);
    return {
      window_start_date: dateStr,
      window_label: `In ${days} Days (${dateStr})`,
      exact_utc_iso: target.toISOString()
    };
  }

  if (/\btomorrow\b/.test(lower)) {
    const target = new Date(referenceDate.getTime() + 86400 * 1000);
    const dateStr = target.toISOString().slice(0, 10);
    return {
      window_start_date: dateStr,
      window_label: `Tomorrow (${dateStr})`,
      exact_utc_iso: target.toISOString()
    };
  }

  // 4. Relative "next <Weekday>" (e.g. "next Friday")
  const nextWeekdayMatch = lower.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nextWeekdayMatch) {
    const targetDow = WEEKDAY_INDEX[nextWeekdayMatch[1]];
    const currentDow = referenceDate.getUTCDay();
    let delta = (targetDow - currentDow + 7) % 7;
    if (delta === 0) delta = 7;
    const target = new Date(Date.UTC(year, month, referenceDate.getUTCDate() + delta, 9, 0, 0));
    const dateStr = target.toISOString().slice(0, 10);
    const dayLabel = nextWeekdayMatch[1][0].toUpperCase() + nextWeekdayMatch[1].slice(1);
    return {
      window_start_date: dateStr,
      window_label: `Next ${dayLabel} (${dateStr})`,
      exact_utc_iso: target.toISOString()
    };
  }

  if (
    lower.includes('end of month') ||
    lower.includes('end of this month') ||
    lower.includes('end of the month') ||
    lower.includes('late october')
  ) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    const checkStart = new Date(Date.UTC(year, month, Math.max(1, lastDay.getUTCDate() - 3)));
    return {
      window_start_date: checkStart.toISOString().slice(0, 10),
      window_label: `End of Month (${checkStart.toLocaleString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
      })})`,
      exact_utc_iso: checkStart.toISOString()
    };
  }

  if (
    lower.includes('early next year') ||
    lower.includes('beginning of next year') ||
    lower.includes('january 2027') ||
    lower.includes('jan 2027') ||
    lower.includes('early 2027')
  ) {
    return {
      window_start_date: `${year + 1}-01-04`,
      window_label: `Early Next Year (Jan ${year + 1})`,
      exact_utc_iso: `${year + 1}-01-04T09:00:00.000Z`
    };
  }

  if (lower.includes('next month') || lower.includes('november')) {
    const nextMonth = new Date(Date.UTC(year, month + 1, 1));
    return {
      window_start_date: nextMonth.toISOString().slice(0, 10),
      window_label: `Next Month (${nextMonth.toLocaleString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
      })})`,
      exact_utc_iso: nextMonth.toISOString()
    };
  }

  if (lower.includes('december') || lower.includes('end of the year') || lower.includes('end of year')) {
    return {
      window_start_date: `${year}-12-01`,
      window_label: `December ${year}`,
      exact_utc_iso: `${year}-12-01T09:00:00.000Z`
    };
  }

  if (lower.includes('spring') || lower.includes('february') || lower.includes('march')) {
    return {
      window_start_date: `${year + 1}-02-01`,
      window_label: `Spring ${year + 1}`,
      exact_utc_iso: `${year + 1}-02-01T09:00:00.000Z`
    };
  }

  // Named date fallback, e.g. "March 10, 2027"
  const namedDateMatch = clean.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(202\d|203\d)\b/);
  if (namedDateMatch && MONTH_INDEX[namedDateMatch[1].toLowerCase()] !== undefined) {
    const mIdx = MONTH_INDEX[namedDateMatch[1].toLowerCase()];
    const day = Number(namedDateMatch[2]);
    const yr = Number(namedDateMatch[3]);
    const dt = new Date(Date.UTC(yr, mIdx, day, 9, 0, 0));
    const dateStr = dt.toISOString().slice(0, 10);
    return {
      window_start_date: dateStr,
      window_label: `${namedDateMatch[1]} ${day}, ${yr}`,
      exact_utc_iso: dt.toISOString()
    };
  }

  return {
    window_start_date: referenceDate.toISOString().slice(0, 10),
    window_label: 'Immediate / Continuous Monitoring',
    exact_utc_iso: referenceDate.toISOString()
  };
}
