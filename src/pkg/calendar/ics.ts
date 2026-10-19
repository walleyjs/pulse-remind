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

  const events = watches.map((w) => {
    const { startUtc, endUtc } = formatIcsDate(w.window_start_date);
    const summary = escapeIcsText(`🔔 ${w.title}`);
    const description = escapeIcsText(
      `Checklist: ${w.chat_context}\nStatus: ${w.status}\nLink: ${w.target_url || baseUrl}`
    );
    const url = w.detected_apply_url || w.target_url || baseUrl;

    return [
      'BEGIN:VEVENT',
      `UID:${w.id}@pulseremind.ai`,
      `DTSTAMP:${nowUtc}`,
      `DTSTART:${startUtc}`,
      `DTEND:${endUtc}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      `URL:${escapeIcsText(url)}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      `DESCRIPTION:PulseRemind Alert: ${summary}`,
      'END:VALARM',
      'END:VEVENT'
    ].join('\r\n');
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PulseRemind//AI Chat Event & Web Monitor//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:PulseRemind Alerts',
    ...events,
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}
