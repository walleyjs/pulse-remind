import type { WatchRecord } from '../../internal/watch/model.ts';

function formatIcsDate(dateStr: string | null | undefined): { startUtc: string; endUtc: string } {
  let d = dateStr ? new Date(dateStr) : new Date(Date.now() + 7 * 86400 * 1000);
  if (isNaN(d.getTime())) {
    d = new Date(Date.now() + 7 * 86400 * 1000);
  }
  // Set to 09:00 UTC on target date if only YYYY-MM-DD was provided
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    d = new Date(`${dateStr.trim()}T09:00:00Z`);
  }
  const end = new Date(d.getTime() + 60 * 60 * 1000); // 1 hour block
  const fmt = (dt: Date) =>
    dt
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  return { startUtc: fmt(d), endUtc: fmt(end) };
}

function escapeIcsText(text: string): string {
  return (text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * RFC 5545 Section 3.1: Content lines longer than 75 octets MUST be folded
 * using CRLF followed immediately by a single linear white-space character (SPACE).
 */
export function foldIcsLine(line: string, maxOctets = 75): string {
  if (Buffer.byteLength(line, 'utf-8') <= maxOctets) {
    return line;
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  let isFirstLine = true;

  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    const limit = isFirstLine ? maxOctets : maxOctets - 1; // account for leading SPACE on continuation
    if (currentBytes + charBytes > limit && current.length > 0) {
      chunks.push(isFirstLine ? current : ` ${current}`);
      current = char;
      currentBytes = charBytes;
      isFirstLine = false;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current.length > 0) {
    chunks.push(isFirstLine ? current : ` ${current}`);
  }
  return chunks.join('\r\n');
}

/**
 * Computes a monotonically increasing RFC 5545 SEQUENCE number for a watch
 * so calendar clients update the existing VEVENT in-place when status, deadline, or checklist changes.
 */
export function computeWatchIcsSequence(watch: WatchRecord): number {
  const explicitSeq = Number(watch.resolution_config?.provider_metadata?.ics_sequence);
  if (!isNaN(explicitSeq) && explicitSeq >= 0) {
    return explicitSeq;
  }
  let seq = 0;
  if (watch.recipient_email) seq += 1;
  if (watch.detected_deadline) seq += 1;
  if (watch.detected_apply_url) seq += 1;
  if (watch.status === 'triggered_open') seq += 2;
  seq += Math.min(10, watch.oracle_responses?.length || 0);
  return seq;
}

export interface WatchCalendarLinks {
  google_calendar_url: string;
  ics_download_url: string;
  webcal_feed_url: string;
}

export function buildWatchCalendarLinks(watch: WatchRecord, baseUrl: string): WatchCalendarLinks {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const { startUtc, endUtc } = formatIcsDate(watch.window_start_date);
  const title = `🔔 ${watch.title} (${watch.window_label || 'Reminder'})`;
  const details = [
    `Action Checklist: ${watch.chat_context}`,
    watch.target_url ? `Official Link: ${watch.target_url}` : '',
    `Monitored by PulseRemind (${cleanBase})`
  ]
    .filter(Boolean)
    .join('\n\n');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${startUtc}/${endUtc}`,
    details,
    ...(watch.target_url ? { location: watch.target_url } : {})
  });

  const icsUrl = `${cleanBase}/api/watches/${encodeURIComponent(watch.id)}/calendar.ics`;
  const webcalUrl = `${cleanBase.replace(/^https?:\/\//i, 'webcal://')}/api/calendar/all.ics`;

  return {
    google_calendar_url: `https://calendar.google.com/calendar/render?${params.toString()}`,
    ics_download_url: icsUrl,
    webcal_feed_url: webcalUrl
  };
}

export function buildWatchIcsFeed(watches: WatchRecord[], baseUrl: string): string {
  const nowUtc = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PulseRemind//AI Chat Event & Web Monitor//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:PulseRemind Alerts'
  ];

  for (const w of watches) {
    const { startUtc, endUtc } = formatIcsDate(w.window_start_date);
    const summary = escapeIcsText(`🔔 ${w.title}`);
    const description = escapeIcsText(
      `Checklist: ${w.chat_context}\nStatus: ${w.status}` +
        (w.detected_deadline ? `\nDeadline: ${w.detected_deadline}` : '') +
        `\nLink: ${w.target_url || baseUrl}`
    );
    const url = w.detected_apply_url || w.target_url || baseUrl;
    const sequence = computeWatchIcsSequence(w);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${w.id}@pulseremind.ai`,
      `SEQUENCE:${sequence}`,
      `DTSTAMP:${nowUtc}`,
      `DTSTART:${startUtc}`,
      `DTEND:${endUtc}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      `URL:${escapeIcsText(url)}`
    );

    if (w.rrule) {
      lines.push(`RRULE:${w.rrule}`);
    }

    lines.push(
      'BEGIN:VALARM',
      'TRIGGER:-PT24H',
      'ACTION:DISPLAY',
      `DESCRIPTION:PulseRemind 24h Alert: ${summary}`,
      'END:VALARM',
      'BEGIN:VALARM',
      'TRIGGER:-PT1H',
      'ACTION:DISPLAY',
      `DESCRIPTION:PulseRemind 1h Alert: ${summary}`,
      'END:VALARM',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      `DESCRIPTION:PulseRemind 15m Alert: ${summary}`,
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map((l) => foldIcsLine(l, 75)).join('\r\n') + '\r\n';
}

/**
 * Validates RFC 5545 structural and octet-folding compliance on generated .ics text.
 */
export function validateIcsCompliance(icsText: string): {
  valid: boolean;
  hasCrlf: boolean;
  maxLineOctets: number;
  sequences: number[];
  errors: string[];
} {
  const errors: string[] = [];
  const hasCrlf = icsText.includes('\r\n');
  if (!hasCrlf) {
    errors.push('Missing CRLF (\\r\\n) line endings');
  }
  const rawLines = icsText.split('\r\n').filter((l) => l.length > 0);
  let maxLineOctets = 0;
  const sequences: number[] = [];

  for (const line of rawLines) {
    const octets = Buffer.byteLength(line, 'utf-8');
    if (octets > maxLineOctets) maxLineOctets = octets;
    if (octets > 75) {
      errors.push(`Line exceeds 75 UTF-8 octets (${octets}): ${line.slice(0, 40)}...`);
    }
    const seqMatch = line.match(/^SEQUENCE:(\d+)$/);
    if (seqMatch) {
      sequences.push(Number(seqMatch[1]));
    }
  }

  if (!icsText.includes('BEGIN:VCALENDAR') || !icsText.includes('END:VCALENDAR')) {
    errors.push('Missing VCALENDAR envelope');
  }

  return {
    valid: errors.length === 0,
    hasCrlf,
    maxLineOctets,
    sequences,
    errors
  };
}
