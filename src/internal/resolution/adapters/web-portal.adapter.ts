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
      /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/demo\/scholarships\/([a-z0-9\-]+)/i
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

    let lastError = '';

    for (const url of endpoints) {
      const canonicalEndpoint = normalizeCanonicalUrl(url) || url;
      const localDemoMatch = canonicalEndpoint.match(
        /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/demo\/scholarships\/([a-z0-9\-]+)/i
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

      await oracleCache.paceRequest();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.resolution.httpTimeoutMs);
        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.status === 429) {
          lastError = `HTTP 429 Rate Limited on ${url}`;
          continue;
        }

        const html = await response.text();
        if (!response.ok) {
          lastError = `HTTP ${response.status} on ${url}`;
          continue;
        }

        oracleCache.set(cacheKey, {
          body: html,
          httpStatus: response.status,
          queryUrl: canonicalEndpoint
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
