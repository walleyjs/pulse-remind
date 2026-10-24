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

export interface StructuredPortalSignals {
  hasStructuredSignal: boolean;
  isOpen: boolean | null;
  confidence: number;
  source: 'json_ld' | 'next_data' | 'opengraph' | 'microdata' | null;
  detectedDeadline: string | null;
  detectedApplyUrl: string | null;
  detectedOpenDate: string | null;
  summaryReason: string | null;
}

function findObjectValues(obj: unknown, collector: Record<string, unknown>[]): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) findObjectValues(item, collector);
    return;
  }
  const rec = obj as Record<string, unknown>;
  collector.push(rec);
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      findObjectValues(val, collector);
    }
  }
}

/**
 * Extracts structured state from embedded `<script type="application/ld+json">` (Schema.org Event/Offer/Program)
 * and SSR hydration blobs (`<script id="__NEXT_DATA__" type="application/json">`).
 */
export function extractStructuredPortalState(
  rawHtml: string,
  baseUrl: string,
  targetCohortYear: number | null
): StructuredPortalSignals {
  const defaultRes: StructuredPortalSignals = {
    hasStructuredSignal: false,
    isOpen: null,
    confidence: 0,
    source: null,
    detectedDeadline: null,
    detectedApplyUrl: null,
    detectedOpenDate: null,
    summaryReason: null
  };

  // 1. Parse <script type="application/ld+json">
  const ldRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRegex.exec(rawHtml)) !== null) {
    try {
      const parsed = JSON.parse(ldMatch[1].trim());
      const nodes: Record<string, unknown>[] = [];
      findObjectValues(parsed, nodes);

      for (const node of nodes) {
        const availability = String(node.availability || '');
        const eventStatus = String(node.eventStatus || '');
        const deadline =
          (node.applicationDeadline as string) ||
          (node.validThrough as string) ||
          (node.endDate as string) ||
          null;
        const startDate =
          (node.applicationStartDate as string) || (node.startDate as string) || null;
        const rawUrl = (node.url as string) || null;
        const resolvedUrl = rawUrl
          ? (() => {
              try {
                return new URL(rawUrl, baseUrl).toString();
              } catch {
                return rawUrl;
              }
            })()
          : null;

        // Check cohort year guard on JSON-LD node name/description
        const nodeText = `${node.name || ''} ${node.description || ''}`;
        if (targetCohortYear) {
          const years = (nodeText.match(/\b(202\d)\b/g) || []).map(Number);
          if (years.length > 0 && !years.includes(targetCohortYear) && years.every((y) => y < targetCohortYear)) {
            continue;
          }
        }

        if (/EventCancelled|EventPostponed/i.test(eventStatus)) {
          return {
            hasStructuredSignal: true,
            isOpen: false,
            confidence: 0.98,
            source: 'json_ld',
            detectedDeadline: deadline,
            detectedApplyUrl: null,
            detectedOpenDate: startDate,
            summaryReason: `Schema.org JSON-LD eventStatus=${eventStatus}`
          };
        }

        if (/SoldOut|OutOfStock|Discontinued|PreSale/i.test(availability)) {
          return {
            hasStructuredSignal: true,
            isOpen: false,
            confidence: 0.96,
            source: 'json_ld',
            detectedDeadline: deadline,
            detectedApplyUrl: null,
            detectedOpenDate: startDate,
            summaryReason: `Schema.org JSON-LD availability=${availability}`
          };
        }

        if (/InStock|PreOrder|OnlineOnly|LimitedAvailability/i.test(availability)) {
          return {
            hasStructuredSignal: true,
            isOpen: true,
            confidence: 0.97,
            source: 'json_ld',
            detectedDeadline: deadline,
            detectedApplyUrl: resolvedUrl,
            detectedOpenDate: startDate,
            summaryReason: `Schema.org JSON-LD availability=${availability}`
          };
        }

        if (/EventScheduled|EventMovedOnline/i.test(eventStatus)) {
          return {
            hasStructuredSignal: true,
            isOpen: true,
            confidence: 0.96,
            source: 'json_ld',
            detectedDeadline: deadline,
            detectedApplyUrl: resolvedUrl,
            detectedOpenDate: startDate,
            summaryReason: `Schema.org JSON-LD eventStatus=${eventStatus}`
          };
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  // 2. Parse Next.js SSR Hydration state (<script id="__NEXT_DATA__" type="application/json">)
  const nextDataMatch = rawHtml.match(
    /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1].trim());
      const nodes: Record<string, unknown>[] = [];
      findObjectValues(parsed, nodes);

      for (const node of nodes) {
        const cohort = Number(node.cohortYear || node.cohort || 0);
        if (targetCohortYear && cohort > 2020 && cohort < targetCohortYear) {
          continue;
        }

        const explicitBool =
          typeof node.applicationsOpen === 'boolean'
            ? node.applicationsOpen
            : typeof node.registrationOpen === 'boolean'
              ? node.registrationOpen
              : typeof node.isOpen === 'boolean'
                ? node.isOpen
                : null;
        const statusStr = typeof node.portalStatus === 'string' ? node.portalStatus.toLowerCase() : null;

        if (explicitBool !== null || statusStr === 'open' || statusStr === 'closed') {
          const isOpen = explicitBool !== null ? explicitBool : statusStr === 'open';
          const rawApply = (node.applyUrl as string) || (node.registrationUrl as string) || null;
          const resolvedApply = rawApply
            ? (() => {
                try {
                  return new URL(rawApply, baseUrl).toString();
                } catch {
                  return rawApply;
                }
              })()
            : null;
          return {
            hasStructuredSignal: true,
            isOpen,
            confidence: 0.97,
            source: 'next_data',
            detectedDeadline: (node.deadline as string) || (node.applicationDeadline as string) || null,
            detectedApplyUrl: isOpen ? resolvedApply : null,
            detectedOpenDate: (node.openDate as string) || null,
            summaryReason: `SSR __NEXT_DATA__ state (isOpen=${isOpen})`
          };
        }
      }
    } catch {
      // Ignore malformed __NEXT_DATA__
    }
  }

  // 2b. Parse Nuxt.js SSR Hydration state (<script id="__NUXT_DATA__" type="application/json">)
  const nuxtDataMatch = rawHtml.match(
    /<script\b[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (nuxtDataMatch) {
    try {
      const parsed = JSON.parse(nuxtDataMatch[1].trim());
      const nodes: Record<string, unknown>[] = [];
      findObjectValues(parsed, nodes);
      for (const node of nodes) {
        if (typeof node.isOpen === 'boolean' || typeof node.registrationOpen === 'boolean') {
          const isOpen = typeof node.isOpen === 'boolean' ? node.isOpen : Boolean(node.registrationOpen);
          return {
            hasStructuredSignal: true,
            isOpen,
            confidence: 0.97,
            source: 'next_data',
            detectedDeadline: (node.deadline as string) || null,
            detectedApplyUrl: (node.applyUrl as string) || null,
            detectedOpenDate: null,
            summaryReason: `SSR __NUXT_DATA__ state (isOpen=${isOpen})`
          };
        }
      }
    } catch {
      // Ignore malformed __NUXT_DATA__
    }
  }

  // 3. Parse OpenGraph / Meta availability tags
  const ogAvailabilityMatch =
    rawHtml.match(
      /<meta\s+[^>]*(?:property|name)=["'](?:og:availability|product:availability|availability)["'][^>]*content=["']([^"']+)["']/i
    ) ||
    rawHtml.match(
      /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:availability|product:availability|availability)["']/i
    );
  if (ogAvailabilityMatch) {
    const val = ogAvailabilityMatch[1].trim();
    if (/instock|in_stock|available/i.test(val)) {
      return {
        hasStructuredSignal: true,
        isOpen: true,
        confidence: 0.95,
        source: 'opengraph',
        detectedDeadline: null,
        detectedApplyUrl: null,
        detectedOpenDate: null,
        summaryReason: `OpenGraph meta availability=${val}`
      };
    }
    if (/oos|out of stock|outofstock|sold_out|soldout|discontinued/i.test(val)) {
      return {
        hasStructuredSignal: true,
        isOpen: false,
        confidence: 0.95,
        source: 'opengraph',
        detectedDeadline: null,
        detectedApplyUrl: null,
        detectedOpenDate: null,
        summaryReason: `OpenGraph meta availability=${val}`
      };
    }
  }

  // 4. Parse Schema.org Microdata (itemprop="availability" or itemprop="eventStatus")
  const eventStatusMicrodata = rawHtml.match(
    /<[^>]+itemprop=["']eventStatus["'][^>]*(?:href|content)=["']https?:\/\/schema\.org\/([^"']+)["']/i
  );
  if (eventStatusMicrodata) {
    const val = eventStatusMicrodata[1].trim();
    if (/EventScheduled|EventMovedOnline/i.test(val)) {
      return {
        hasStructuredSignal: true,
        isOpen: true,
        confidence: 0.96,
        source: 'microdata',
        detectedDeadline: null,
        detectedApplyUrl: null,
        detectedOpenDate: null,
        summaryReason: `Microdata itemprop eventStatus=${val}`
      };
    }
    if (/EventCancelled|EventPostponed/i.test(val)) {
      return {
        hasStructuredSignal: true,
        isOpen: false,
        confidence: 0.96,
        source: 'microdata',
        detectedDeadline: null,
        detectedApplyUrl: null,
        detectedOpenDate: null,
        summaryReason: `Microdata itemprop eventStatus=${val}`
      };
    }
  }

  const microdataMatch = rawHtml.match(
    /<[^>]+itemprop=["']availability["'][^>]*(?:href|content)=["']https?:\/\/schema\.org\/([^"']+)["']/i
  );
  if (microdataMatch) {
    const val = microdataMatch[1].trim();
    if (/InStock|PreOrder|LimitedAvailability/i.test(val)) {
      return {
        hasStructuredSignal: true,
        isOpen: true,
        confidence: 0.96,
        source: 'microdata',
        detectedDeadline: null,
        detectedApplyUrl: null,
        detectedOpenDate: null,
        summaryReason: `Microdata itemprop availability=${val}`
      };
    }
    if (/OutOfStock|SoldOut|Discontinued/i.test(val)) {
      return {
        hasStructuredSignal: true,
        isOpen: false,
        confidence: 0.96,
        source: 'microdata',
        detectedDeadline: null,
        detectedApplyUrl: null,
        detectedOpenDate: null,
        summaryReason: `Microdata itemprop availability=${val}`
      };
    }
  }

  return defaultRes;
}

/**
 * Depth-aware removal of balanced HTML tag blocks (e.g. nested `<nav>...</nav>`, `<footer>...</footer>`, `<aside>...</aside>`).
 */
function stripBalancedTagBlocks(html: string, tagName: string): string {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`<\\/${tagName}\\s*>`, 'gi');
  let result = html;
  let safetyCounter = 0;

  while (safetyCounter++ < 25) {
    openRe.lastIndex = 0;
    const firstOpen = openRe.exec(result);
    if (!firstOpen) break;

    let depth = 1;
    let searchPos = openRe.lastIndex;
    let cutEnd = -1;

    while (depth > 0 && searchPos < result.length) {
      openRe.lastIndex = searchPos;
      closeRe.lastIndex = searchPos;
      const nextOpen = openRe.exec(result);
      const nextClose = closeRe.exec(result);

      if (!nextClose) {
        cutEnd = result.length;
        break;
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        searchPos = openRe.lastIndex;
      } else {
        depth--;
        searchPos = closeRe.lastIndex;
        if (depth === 0) {
          cutEnd = searchPos;
        }
      }
    }

    if (cutEnd !== -1) {
      result = result.slice(0, firstOpen.index) + ' ' + result.slice(cutEnd);
    } else {
      break;
    }
  }

  return result;
}

/**
 * Strips site-wide boilerplate (<nav>, <header>, <footer>, <aside>, <script>, <style>, [hidden], [inert])
 * using depth-aware balanced tag removal so unrelated navbar/footer CTA buttons never cause false-positive triggers.
 */
export function extractSemanticMainHtml(html: string): string {
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  for (const tag of ['nav', 'footer', 'aside', 'dialog', 'template']) {
    cleaned = stripBalancedTagBlocks(cleaned, tag);
  }

  cleaned = cleaned
    .replace(
      /<[^>]+(?:style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["']|\bhidden\b|\binert\b|aria-hidden=["']true["'])[^>]*>[\s\S]*?<\/[a-z0-9]+>/gi,
      ' '
    )
    .replace(
      /<[^>]+(?:role=["'](?:dialog|alertdialog)["'])[^>]*>[\s\S]*?<\/[a-z0-9]+>/gi,
      ' '
    )
    .replace(
      /<(?:div|section)\b[^>]*class=["'][^"']*(?:modal|overlay|popup|toast|cookie-banner)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi,
      ' '
    )
    .replace(
      /<header\b[^>]*class=["'][^"']*(?:site-header|global-header|navbar|top-nav)[^"']*["'][^>]*>[\s\S]*?<\/header>/gi,
      ' '
    );

  return cleaned;
}

export function stripHtmlToText(html: string): string {
  const semanticHtml = extractSemanticMainHtml(html);
  // Also preserve entity title text from JSON-LD or __NEXT_DATA__ when the page is an SSR shell
  let structuredText = '';
  const ldMatches = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (ldMatches) {
    structuredText += ' ' + ldMatches.join(' ').replace(/<[^>]+>/g, ' ');
  }
  const nextMatch = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    structuredText += ' ' + nextMatch[1];
  }

  const combined = `${semanticHtml} ${structuredText}`;
  return combined
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(
      /\b(?:ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+all\s+prior\s+instructions|system\s+prompt\s*:)/gi,
      '[FILTERED_PROMPT_INJECTION]'
    )
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
    /(?:deadline|apply before|register before|closes on|due by|submission deadline|ends on|open until|until)\s*[:\-–]?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*AoE)?)/i,
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
 * - Extracts `<script type="application/ld+json">` and SSR `__NEXT_DATA__` hydration state
 * - Strips nested `<nav>`/`<footer>`/`<aside>` boilerplate via depth-aware scanner
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
  const visibleCleanText = semanticHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Determine target cohort year if specified in watch title (e.g. "2027")
  const titleYearMatch = watch.title.match(/\b(202[6-9]|203\d)\b/);
  const targetCohortYear = titleYearMatch ? Number(titleYearMatch[1]) : null;

  // Check structured JSON-LD & __NEXT_DATA__ state first
  const structured = extractStructuredPortalState(rawHtml, baseUrl, targetCohortYear);

  const sentences = visibleCleanText
    .split(/(?<=[.!?•])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const matchedOpen: string[] = [];
  const matchedClosed: string[] = [];
  const rejectedReasons: string[] = [];

  if (structured.hasStructuredSignal && structured.summaryReason) {
    if (structured.isOpen) {
      matchedOpen.push(structured.summaryReason);
    } else {
      matchedClosed.push(structured.summaryReason);
    }
  }

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
  const candidateApplyUrl = structured.detectedApplyUrl || extractApplyUrl(rawHtml, baseUrl);
  const detectedDeadline =
    structured.detectedDeadline || extractDeadlineFromText(visibleCleanText);
  const detectedOpenDate =
    structured.detectedOpenDate || extractOpeningWindowFromText(visibleCleanText);

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
  } else if (structured.hasStructuredSignal && structured.isOpen !== null) {
    isOpen = structured.isOpen;
    outcome = isOpen ? 1 : null;
    confidence = structured.confidence;
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
    !NEGATION_OR_FUTURE_MODALS.test(visibleCleanText)
  ) {
    isOpen = true;
    outcome = 1;
    confidence = 0.88;
  } else if (
    candidateApplyUrl &&
    matchedClosed.length === 0 &&
    !NEGATION_OR_FUTURE_MODALS.test(visibleCleanText) &&
    (detectedDeadline || /apply|register|regist|tickets|submit|enroll|booking|sign up/i.test(visibleCleanText))
  ) {
    isOpen = true;
    outcome = 1;
    confidence = 0.90;
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
