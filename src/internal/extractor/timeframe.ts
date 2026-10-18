export interface TimeframeResolution {
  window_start_date: string;
  window_label: string;
}

/**
 * Resolves conversational timeframe expressions ("end of this month", "early next year",
 * "next month", "December", "Spring", etc.) into concrete ISO dates and human labels.
 */
export function resolveTimeframeWindow(
  text: string,
  referenceDate = new Date('2026-10-18T12:00:00Z')
): TimeframeResolution {
  const lower = text.toLowerCase();
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();

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
      })})`
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
      window_label: `Early Next Year (Jan ${year + 1})`
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
      })})`
    };
  }

  if (lower.includes('december') || lower.includes('end of the year') || lower.includes('end of year')) {
    return {
      window_start_date: `${year}-12-01`,
      window_label: `December ${year}`
    };
  }

  if (lower.includes('spring') || lower.includes('february') || lower.includes('march')) {
    return {
      window_start_date: `${year + 1}-02-01`,
      window_label: `Spring ${year + 1}`
    };
  }

  return {
    window_start_date: referenceDate.toISOString().slice(0, 10),
    window_label: 'Immediate / Continuous Monitoring'
  };
}
