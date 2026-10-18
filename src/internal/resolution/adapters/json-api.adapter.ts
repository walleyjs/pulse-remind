import { oracleCache } from '../../../pkg/cache/oracle-cache.ts';
import type { OracleResponseRecord, WatchRecord } from '../../watch/model.ts';
import type { DecisionMakerAdapter, EvaluationResult } from '../types.ts';
import { validateEntityMatch } from '../validator.ts';

/**
 * Pluggable JSON API Oracle Adapter for scholarships/admissions portals that expose JSON APIs.
 */
export class JsonApiOracleAdapter implements DecisionMakerAdapter {
  readonly oracleName = 'json_api_oracle';

  async resolve(watch: WatchRecord, bypassCache = false): Promise<EvaluationResult> {
    const url = watch.target_url;
    if (!url) {
      throw new Error('JSON API adapter requires a target_url');
    }

    let rawJson = '';
    let httpStatus = 200;
    let cacheHit = false;

    const cached = !bypassCache ? oracleCache.get(url) : null;
    if (cached) {
      rawJson = cached.body;
      httpStatus = cached.httpStatus;
      cacheHit = true;
    } else {
      await oracleCache.paceRequest();
      const res = await fetch(url, {
        headers: { Accept: 'application/json' }
      });
      httpStatus = res.status;
      rawJson = await res.text();
      if (!res.ok) {
        throw new Error(`JSON Oracle HTTP ${httpStatus} on ${url}`);
      }
      oracleCache.set(url, { body: rawJson, httpStatus, queryUrl: url });
    }

    const entityCheck = validateEntityMatch(watch, rawJson);
    if (!entityCheck.valid) {
      throw new Error(`Entity mismatch on JSON oracle ${url} for "${watch.title}"`);
    }

    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const isOpen =
      parsed.status === 'open' ||
      parsed.is_open === true ||
      parsed.applications_open === true;
    const deadline = typeof parsed.deadline === 'string' ? parsed.deadline : null;
    const applyUrl = typeof parsed.apply_url === 'string' ? parsed.apply_url : url;

    const oracleRecord: OracleResponseRecord = {
      oracle_name: this.oracleName,
      query_url: url,
      response_json: rawJson.slice(0, 1000),
      recorded_at: new Date().toISOString(),
      cache_hit: cacheHit,
      entity_validated: true
    };

    return {
      httpStatus,
      isOpen,
      outcome: isOpen ? 1 : null,
      confidence: 0.99,
      summary: isOpen ? `JSON Oracle confirmed status=OPEN` : `JSON Oracle status=CLOSED`,
      extractedSnippet: rawJson.slice(0, 240),
      snapshotHash: null,
      pageChanged: false,
      detectedDeadline: deadline,
      detectedOpenDate: null,
      detectedApplyUrl: isOpen ? applyUrl : null,
      oracleRecord,
      cacheHit,
      entityValidated: true
    };
  }
}

export const jsonApiOracleAdapter = new JsonApiOracleAdapter();
