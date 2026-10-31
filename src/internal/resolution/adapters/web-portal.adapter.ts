import crypto from 'node:crypto';
import { config } from '../../../config/index.ts';
import { oracleCache } from '../../../pkg/cache/oracle-cache.ts';
import { demoPortalService } from '../../demo/service.ts';
import type { OracleResponseRecord, WatchRecord } from '../../watch/model.ts';
import type { DecisionMakerAdapter, EvaluationResult } from '../types.ts';
import {
  evaluateWebpageSignals,
  normalizeCanonicalUrl,
  stripHtmlToText,
  validateEntityMatch
} from '../validator.ts';
import {
  evaluateCommercePredicate,
  extractStructuredCommerceState
} from '../predicates.ts';

export class WebPortalOracleAdapter implements DecisionMakerAdapter {
  readonly oracleName = 'web_portal_oracle';

  async fetchWithCacheAndFailover(
    watch: WatchRecord,
    bypassCache = false
  ): Promise<{ html: string; httpStatus: number; queryUrl: string; cacheHit: boolean }> {
    const primaryUrl = watch.target_url!;
    const canonicalPrimary = normalizeCanonicalUrl(primaryUrl) || primaryUrl;

    // Allow deterministic HTML fixture injection via provider_metadata for adversarial replay testing
    const inlineFixture = watch.resolution_config?.provider_metadata?.raw_html_fixture;
    if (inlineFixture) {
      return {
        html: inlineFixture,
        httpStatus: 200,
        queryUrl: canonicalPrimary,
        cacheHit: false
      };
    }

    const endpoints = [primaryUrl];
    if (watch.secondary_url) {
      endpoints.push(watch.secondary_url);
    } else if (watch.resolution_config?.secondary_source_url) {
      endpoints.push(watch.resolution_config.secondary_source_url);
    }

    let cacheKey = canonicalPrimary;
    const primaryLocalMatch = canonicalPrimary.match(
      /^https?:\/\/(?:localhost|127\.0\.0\.1|pulse-remind\.onrender\.com)(?::\d+)?\/demo\/scholarships\/([a-z0-9\-]+)/i
    );
    if (primaryLocalMatch) {
      const p = demoPortalService.getPortal(primaryLocalMatch[1]);
      if (p) {
        cacheKey = `${canonicalPrimary}::open=${p.is_open ? 1 : 0}`;
      }
    }

    if (!bypassCache) {
      const cached = oracleCache.get(cacheKey);
      if (cached) {
        return {
          html: cached.body,
          httpStatus: cached.httpStatus,
          queryUrl: cached.queryUrl,
          cacheHit: true
        };
      }
    }

    const staleEntry = oracleCache.getStaleEntry(cacheKey);
    const savedEtag =
      staleEntry?.etag || watch.resolution_config?.provider_metadata?.http_etag || undefined;
    const savedLastModified =
      staleEntry?.lastModified ||
      watch.resolution_config?.provider_metadata?.http_last_modified ||
      undefined;

    let lastError = '';

    for (const url of endpoints) {
      const canonicalEndpoint = normalizeCanonicalUrl(url) || url;
      const localDemoMatch = canonicalEndpoint.match(
        /^https?:\/\/(?:localhost|127\.0\.0\.1|pulse-remind\.onrender\.com)(?::\d+)?\/demo\/scholarships\/([a-z0-9\-]+)/i
      );

      if (localDemoMatch) {
        const portal = demoPortalService.getPortal(localDemoMatch[1]);
        if (!portal) {
          lastError = `Demo scholarship portal "${localDemoMatch[1]}" not found`;
          continue;
        }
        const html = demoPortalService.renderScholarshipHtml(portal);
        oracleCache.set(cacheKey, {
          body: html,
          httpStatus: 200,
          queryUrl: canonicalEndpoint
        });
        return { html, httpStatus: 200, queryUrl: canonicalEndpoint, cacheHit: false };
      }

      const localDealMatch = url.match(
        /^https?:\/\/(?:localhost|127\.0\.0\.1|pulse-remind\.onrender\.com)(?::\d+)?\/demo\/deal-portal/i
      );
      if (localDealMatch) {
        const parsedDealUrl = new URL(url);
        const priceParam = parseFloat(parsedDealUrl.searchParams.get('price') || '1499.00');
        const listPriceParam = parseFloat(parsedDealUrl.searchParams.get('list_price') || '1999.00');
        const ratingParam = parseFloat(parsedDealUrl.searchParams.get('rating') || '4.8');
        const reviewsParam = parseInt(parsedDealUrl.searchParams.get('reviews') || '420', 10);
        const promoParam = (parsedDealUrl.searchParams.get('promo') || 'SAVE20').toUpperCase();
        const stockParam = parsedDealUrl.searchParams.get('stock') === 'out' ? 'OutOfStock' : 'InStock';
        const titleParam = parsedDealUrl.searchParams.get('title') || 'Apple MacBook Pro M4 Max 16-inch';
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${titleParam} — Official Deal Portal</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": ${JSON.stringify(titleParam)},
    "aggregateRating": {
      "@type": "AggregateRating",
      "ratingValue": "${ratingParam}",
      "reviewCount": "${reviewsParam}",
      "bestRating": "5"
    },
    "offers": {
      "@type": "Offer",
      "price": "${priceParam.toFixed(2)}",
      "highPrice": "${listPriceParam.toFixed(2)}",
      "priceCurrency": "USD",
      "availability": "https://schema.org/${stockParam}",
      "priceValidUntil": "2026-12-31",
      "seller": {
        "@type": "Organization",
        "name": "Verified Direct Store"
      }
    }
  }
  </script>
</head>
<body>
  <h1>${titleParam}</h1>
  <p>Current Price: USD ${priceParam.toFixed(2)} (List: USD ${listPriceParam.toFixed(2)})</p>
  <p>Verified Rating: ${ratingParam} stars (${reviewsParam} reviews)</p>
  <p>Promo Status: Promo code '${promoParam}' gives 20% off at checkout.</p>
</body>
</html>`;
        return { html, httpStatus: 200, queryUrl: url, cacheHit: false };
      }

      await oracleCache.paceRequest();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.resolution.httpTimeoutMs);
        const reqHeaders: Record<string, string> = {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        };
        if (savedEtag && !bypassCache) {
          reqHeaders['If-None-Match'] = savedEtag;
        }
        if (savedLastModified && !bypassCache) {
          reqHeaders['If-Modified-Since'] = savedLastModified;
        }

        const response = await fetch(url, {
          headers: reqHeaders,
          signal: controller.signal
        });
        clearTimeout(timeout);

        // Handle HTTP 304 Not Modified conditional revalidation
        if (response.status === 304 && staleEntry) {
          const touched = oracleCache.touchRevalidated(cacheKey) || staleEntry;
          return {
            html: touched.body,
            httpStatus: 304,
            queryUrl: canonicalEndpoint,
            cacheHit: true
          };
        }

        if (response.status === 429) {
          lastError = `HTTP 429 Rate Limited on ${url}`;
          continue;
        }

        const html = await response.text();
        if (!response.ok) {
          lastError = `HTTP ${response.status} on ${url}`;
          continue;
        }

        const respEtag = response.headers.get('etag') || undefined;
        const respLastMod = response.headers.get('last-modified') || undefined;

        oracleCache.set(cacheKey, {
          body: html,
          httpStatus: response.status,
          queryUrl: canonicalEndpoint,
          etag: respEtag,
          lastModified: respLastMod
        });

        return { html, httpStatus: response.status, queryUrl: canonicalEndpoint, cacheHit: false };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    throw new Error(lastError || `Failed to fetch ${primaryUrl}`);
  }

  async resolve(watch: WatchRecord, bypassCache = false): Promise<EvaluationResult> {
    if (!watch.target_url) {
      const now = new Date();
      const targetDate = watch.window_start_date ? new Date(watch.window_start_date) : null;
      const isDateReached = targetDate ? now >= targetDate : true;
      return {
        httpStatus: null,
        isOpen: isDateReached,
        outcome: isDateReached ? 1 : null,
        confidence: 1.0,
        summary: isDateReached
          ? `Scheduled reminder window (${watch.window_label || watch.window_start_date || 'now'}) has arrived!`
          : `Waiting until scheduled window (${watch.window_label || watch.window_start_date}).`,
        extractedSnippet: watch.chat_context,
        snapshotHash: null,
        pageChanged: false,
        detectedDeadline: null,
        detectedOpenDate: watch.window_label,
        detectedApplyUrl: null,
        oracleRecord: null,
        cacheHit: false,
        entityValidated: true
      };
    }

    const { html, httpStatus, queryUrl, cacheHit } = await this.fetchWithCacheAndFailover(
      watch,
      bypassCache
    );
    const cleanText = stripHtmlToText(html);
    const lowerText = cleanText.toLowerCase();
    const snapshotHash = crypto.createHash('sha256').update(cleanText).digest('hex').slice(0, 16);
    const pageChanged = Boolean(
      watch.last_snapshot_hash && watch.last_snapshot_hash !== snapshotHash
    );

    const entityCheck = validateEntityMatch(watch, cleanText);
    if (!entityCheck.valid) {
      throw new Error(
        `Entity mismatch. Target page content at ${queryUrl} did not match any expected tokens for "${watch.title}". Auto-resolution paused for review.`
      );
    }

    // Dual-Mode Resolution: If watch has a Commerce Predicate, run structured price/rating/promo evaluation
    if (watch.commerce_predicate) {
      const extractedCommerce = extractStructuredCommerceState(
        html,
        watch.commerce_predicate.requiredPromoCode
      );
      const commerceEval = evaluateCommercePredicate(extractedCommerce, watch.commerce_predicate);
      const isOpen = commerceEval.satisfied;
      const outcome = isOpen ? 1 : null;
      const confidence = isOpen ? 0.98 : 0.92;
      const detectedDeadline = extractedCommerce.priceValidUntil || null;

      const oracleRecord: OracleResponseRecord = {
        oracle_name: this.oracleName,
        query_url: queryUrl,
        response_json: JSON.stringify({
          is_open: isOpen,
          outcome,
          confidence,
          commerce_predicate: watch.commerce_predicate,
          commerce_evaluation: commerceEval,
          entity_token: entityCheck.matchedToken,
          snapshot_hash: snapshotHash
        }),
        recorded_at: new Date().toISOString(),
        cache_hit: cacheHit,
        entity_validated: true
      };

      const summaryPrefix = isOpen
        ? `DEAL / PRICE TARGET MET (${Math.round(confidence * 100)}% confidence, Entity "${entityCheck.matchedToken}" verified)`
        : `Monitoring Commerce Threshold (Entity "${entityCheck.matchedToken}" verified)`;
      const summary = `${summaryPrefix}: ${commerceEval.reasons.join(' | ')}`;

      return {
        httpStatus,
        isOpen,
        outcome,
        confidence,
        summary,
        extractedSnippet: cleanText.slice(0, 260),
        snapshotHash,
        pageChanged,
        detectedDeadline,
        detectedOpenDate: null,
        detectedApplyUrl: queryUrl,
        oracleRecord,
        cacheHit,
        entityValidated: true,
        commerceEvaluation: commerceEval
      };
    }

    const analysis = evaluateWebpageSignals(watch, html, queryUrl);
    const {
      isOpen,
      outcome,
      confidence,
      matchedOpen,
      matchedClosed,
      detectedApplyUrl,
      detectedDeadline,
      detectedOpenDate,
      rejectedReasons
    } = analysis;

    let snippet = cleanText.slice(0, 260);
    const keyTerms = [...matchedOpen, ...matchedClosed, 'applications', 'scholarship', 'cohort'];
    for (const term of keyTerms) {
      const idx = lowerText.indexOf(term.toLowerCase());
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(cleanText.length, idx + 210);
        snippet =
          (start > 0 ? '...' : '') +
          cleanText.slice(start, end).trim() +
          (end < cleanText.length ? '...' : '');
        break;
      }
    }

    const oracleRecord: OracleResponseRecord = {
      oracle_name: this.oracleName,
      query_url: queryUrl,
      response_json: JSON.stringify({
        is_open: isOpen,
        outcome,
        confidence,
        matched_open: matchedOpen,
        matched_closed: matchedClosed,
        rejected_reasons: rejectedReasons,
        detected_deadline: detectedDeadline,
        detected_open_date: detectedOpenDate,
        entity_token: entityCheck.matchedToken,
        snapshot_hash: snapshotHash
      }),
      recorded_at: new Date().toISOString(),
      cache_hit: cacheHit,
      entity_validated: true
    };

    const summary = isOpen
      ? `OPEN DETECTED (${Math.round(confidence * 100)}% confidence, Entity "${entityCheck.matchedToken}" verified): Matched [${
          matchedOpen.join(', ') || 'active portal state'
        }]` + (detectedDeadline ? ` • Deadline: ${detectedDeadline}` : '')
      : `Pre-opening / Closed (${Math.round(confidence * 100)}% confidence, Entity "${entityCheck.matchedToken}" verified): ${
          matchedClosed.length > 0
            ? `Page indicates [${matchedClosed.join(', ')}]`
            : 'No open application signals found yet'
        }`;

    return {
      httpStatus,
      isOpen,
      outcome,
      confidence,
      summary,
      extractedSnippet: snippet,
      snapshotHash,
      pageChanged,
      detectedDeadline,
      detectedOpenDate,
      detectedApplyUrl,
      oracleRecord,
      cacheHit,
      entityValidated: true
    };
  }
}

export const webPortalOracleAdapter = new WebPortalOracleAdapter();
