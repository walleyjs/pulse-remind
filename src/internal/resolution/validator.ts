import type { WatchRecord } from '../watch/model.ts';

/**
 * Adapted from Octopus `normalize_name` (`src/internal/resolution/adapters/espn.rs:865`)
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalizes a URL into a canonical target key (stripping UTM/tracking params, fragments, and trailing slashes)
 * so N user watches targeting the same scholarship page share 1 canonical resolution target.
 */
export function normalizeCanonicalUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'ref',
      'source'
    ];
    for (const p of trackingParams) {
      parsed.searchParams.delete(p);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return rawUrl.trim().replace(/\/+$/, '');
  }
}

const GENERIC_STOP_WORDS = new Set([
  'scholarship',
  'fellowship',
  'grant',
  'program',
  'award',
  'admission',
  'bursary',
  'fund',
  'graduate',
  'international',
  'application',
  'event',
  'conference',
  'summit',
  'festival',
  'concert',
  'tickets',
  'ticket',
  'registration',
  'launch',
  'release',
  'reminder',
  'hackathon',
  'bootcamp',
  'test',
  'demo',
  'watch',
  'with',
  'from',
  'that',
  'this',
  'cohort',
  'intake'
]);

/**
 * Adapted from Octopus Entity Validation (`espn.rs:1022-1050` & `sports.rs:167-187`).
 * Ensures the scraped webpage actually belongs to the watched event, product, or opportunity.
 */
export function validateEntityMatch(
  watch: WatchRecord,
  pageText: string
): { valid: boolean; matchedToken?: string } {
  if (watch.resolution_config && watch.resolution_config.entity_must_match === false) {
    return { valid: true, matchedToken: 'entity_check_disabled' };
  }

  const normalizedPage = normalizeText(pageText);
  const candidateSource = `${watch.title} ${watch.resolution_config?.primary_source_name || ''}`;
  const tokens = normalizeText(candidateSource)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3 && !GENERIC_STOP_WORDS.has(t) && !/^202\d$/.test(t));

  if (tokens.length === 0) {
    return { valid: true, matchedToken: 'generic_title' };
  }

  for (const token of tokens) {
    if (normalizedPage.includes(token)) {
      return { valid: true, matchedToken: token };
    }
  }

  return { valid: false };
}

/**
 * Strips site-wide boilerplate (<nav>, <header>, <footer>, <aside>, <script>, <style>)
 * so unrelated navbar/footer CTA buttons never cause false-positive triggers.
 */
export function extractSemanticMainHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Remove semantic boilerplate regions & hidden prompt-injection containers
  const withoutBoilerplate = withoutScripts
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'][^>]*>[\s\S]*?<\/[a-z0-9]+>/gi, ' ')
    .replace(/<header\b[^>]*class=["'][^"']*(?:site-header|global-header|navbar|top-nav)[^"']*["'][^>]*>[\s\S]*?<\/header>/gi, ' ');

  return withoutBoilerplate;
}

export function stripHtmlToText(html: string): string {
  const semanticHtml = extractSemanticMainHtml(html);
  return semanticHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\b(?:ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+all\s+prior\s+instructions|system\s+prompt\s*:)/gi, '[FILTERED_PROMPT_INJECTION]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts a live, non-disabled CTA URL (Apply, Register, Get Tickets, Sign Up, Enroll) from the semantic main content.
 * Rejects disabled links (`aria-disabled="true"`, `disabled`, `class="...disabled..."`, `href="#"`, `javascript:`).
 */
export function extractApplyUrl(html: string, baseUrl: string): string | null {
  const semanticHtml = extractSemanticMainHtml(html);
  const linkRegex = /<a\s+([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(semanticHtml)) !== null) {
    const attrs = match[1].toLowerCase();
    const href = match[2].trim();
    const anchorText = match[3]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // Reject disabled or dead placeholder links
    if (
      !href ||
      href === '#' ||
      href.toLowerCase().startsWith('javascript:') ||
      /\bdisabled\b/.test(attrs) ||
      /aria-disabled=["']true["']/.test(attrs) ||
      anchorText.includes('closed') ||
      anchorText.includes('not open') ||
      anchorText.includes('sold out') ||
      anchorText.includes('coming soon')
    ) {
      continue;
    }

    if (
      anchorText.includes('apply now') ||
      anchorText.includes('start application') ||
      anchorText.includes('submit application') ||
      anchorText.includes('application portal') ||
      anchorText.includes('online application') ||
      anchorText.includes('register now') ||
      anchorText.includes('get tickets') ||
      anchorText.includes('buy tickets') ||
      anchorText.includes('sign up now') ||
      anchorText.includes('enroll now') ||
      href.toLowerCase().includes('/apply') ||
      href.toLowerCase().includes('/register') ||
      href.toLowerCase().includes('/tickets')
    ) {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return href;
      }
    }
  }
  return null;
}

export function extractDeadlineFromText(text: string): string | null {
  const patterns = [
    /(?:deadline|apply before|register before|closes on|due by|submission deadline|ends on)\s*[:\-–]?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
    /(?:deadline|apply before|register before|closes on|due by)\s*[:\-–]?\s*(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/i,
    /(?:before|by)\s+([A-Z][a-z]+\s+\d{1,2},?\s+202[6-9])/i
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return null;
}

export function extractOpeningWindowFromText(text: string): string | null {
  const m = text.match(
    /(?:will open|opens|goes on sale|opening Window)\s*[:\-–]?\s*((?:End of|Early|Late)?\s*[A-Z][a-z]+\s+202[6-9])/i
  );
  return m && m[1] ? m[1].trim() : null;
}

const NEGATION_OR_FUTURE_MODALS =
  /\b(not\s+open|not\s+yet\s+open|not\s+yet\s+on\s+sale|no\s+longer\s+open|no\s+longer\s+accepting|not\s+accepting|currently\s+closed|are\s+closed|is\s+closed|have\s+closed|has\s+closed|will\s+open|opens\s+in|opens\s+on|will\s+go\s+on\s+sale|goes\s+on\s+sale\s+in|expected\s+to\s+open|once\s+the\s+portal\s+opens|once\s+applications\s+open|once\s+registration\s+opens|when\s+applications\s+open|when\s+registration\s+opens|able\s+to\s+apply\s+online\s+once|will\s+be\s+able\s+to\s+apply|will\s+be\s+able\s+to\s+register)\b/i;

export interface AdversarialSignalAnalysis {
  isOpen: boolean;
  outcome: 1 | 2 | null;
  confidence: number;
  matchedOpen: string[];
  matchedClosed: string[];
  detectedApplyUrl: string | null;
  detectedDeadline: string | null;
  detectedOpenDate: string | null;
  rejectedReasons: string[];
}

/**
 * Evaluates webpage HTML against adversarial real-world edge cases:
 * - Strips <nav>/<footer>/<aside> boilerplate
 * - Evaluates sentence-level negation & future modals ("will be able to apply online once it opens")
 * - Verifies cohort year alignment (e.g. rejects "2025 applications are open" when watching 2027)
 * - Verifies active, non-disabled CTA link
 */
export function evaluateWebpageSignals(
  watch: WatchRecord,
  rawHtml: string,
  baseUrl: string
): AdversarialSignalAnalysis {
  const semanticHtml = extractSemanticMainHtml(rawHtml);
  const cleanText = stripHtmlToText(rawHtml);
  const sentences = cleanText
    .split(/(?<=[.!?•])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Determine target cohort year if specified in watch title (e.g. "2027")
  const titleYearMatch = watch.title.match(/\b(202[6-9]|203\d)\b/);
  const targetCohortYear = titleYearMatch ? Number(titleYearMatch[1]) : null;

  const matchedOpen: string[] = [];
  const matchedClosed: string[] = [];
  const rejectedReasons: string[] = [];

  for (const sentence of sentences) {
    const lowerSentence = sentence.toLowerCase();

    // Check closed keywords first
    for (const ckw of watch.closed_keywords) {
      if (lowerSentence.includes(ckw.toLowerCase()) && !matchedClosed.includes(ckw)) {
        matchedClosed.push(ckw);
      }
    }

    // Check open keywords with sentence-level negation & cohort-year guards
    for (const okw of watch.expected_keywords) {
      if (!lowerSentence.includes(okw.toLowerCase())) continue;

      if (NEGATION_OR_FUTURE_MODALS.test(sentence)) {
        rejectedReasons.push(`Rejected "${okw}" due to negation/future modal in: "${sentence.slice(0, 90)}"`);
        if (!matchedClosed.includes('future/negated modal')) {
          matchedClosed.push('future/negated modal');
        }
        continue;
      }

      if (targetCohortYear) {
        const yearsInSentence = (sentence.match(/\b(202\d)\b/g) || []).map(Number);
        if (
          yearsInSentence.length > 0 &&
          !yearsInSentence.includes(targetCohortYear) &&
          yearsInSentence.every((y) => y < targetCohortYear)
        ) {
          rejectedReasons.push(
            `Rejected "${okw}" due to stale cohort year (${yearsInSentence.join(',')}) < target ${targetCohortYear}`
          );
          continue;
        }
      }

      if (!matchedOpen.includes(okw)) {
        matchedOpen.push(okw);
      }
    }
  }

  const explicitOpenAttr = /data-portal-status=["']open["']/i.test(semanticHtml);
  const explicitClosedAttr = /data-portal-status=["']closed["']/i.test(semanticHtml);
  const candidateApplyUrl = extractApplyUrl(rawHtml, baseUrl);
  const detectedDeadline = extractDeadlineFromText(cleanText);
  const detectedOpenDate = extractOpeningWindowFromText(cleanText);

  let isOpen = false;
  let outcome: 1 | 2 | null = null;
  let confidence = 0.5;

  if (explicitClosedAttr) {
    isOpen = false;
    outcome = null;
    confidence = 0.96;
  } else if (explicitOpenAttr) {
    isOpen = true;
    outcome = 1;
    confidence = 0.98;
  } else if (matchedOpen.length > 0 && matchedClosed.length === 0) {
    // Require either a valid non-disabled Apply CTA link OR high-confidence open phrasing
    if (candidateApplyUrl || matchedOpen.length >= 2) {
      isOpen = true;
      outcome = 1;
      confidence = Math.min(0.96, 0.7 + matchedOpen.length * 0.1 + (candidateApplyUrl ? 0.1 : 0));
    } else {
      isOpen = false;
      outcome = null;
      confidence = 0.65;
      rejectedReasons.push('Single open keyword without an active Apply CTA link');
    }
  } else if (
    matchedOpen.length > matchedClosed.length &&
    candidateApplyUrl &&
    !NEGATION_OR_FUTURE_MODALS.test(cleanText)
  ) {
    isOpen = true;
    outcome = 1;
    confidence = 0.88;
  } else {
    isOpen = false;
    outcome = null;
    confidence = matchedClosed.length > 0 ? 0.92 : 0.75;
  }

  if (!isOpen && detectedDeadline) {
    const parsedDeadline = new Date(detectedDeadline);
    if (!isNaN(parsedDeadline.getTime()) && parsedDeadline.getTime() < Date.now()) {
      outcome = 2;
    }
  }

  return {
    isOpen,
    outcome,
    confidence,
    matchedOpen,
    matchedClosed,
    detectedApplyUrl: isOpen ? candidateApplyUrl || baseUrl : null,
    detectedDeadline,
    detectedOpenDate,
    rejectedReasons
  };
}
