import { config } from '../../config/index.ts';

export interface CachedResponseEntry {
  body: string;
  httpStatus: number;
  queryUrl: string;
  fetchedAtMs: number;
}

/**
 * Dual-Mode Oracle Cache & Outbound Rate Limiter:
 * - L1: Fast in-memory Map for sub-millisecond local & single-node lookups.
 * - L2: Optional Upstash Redis REST backend (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)
 *   for distributed multi-worker deduplication across cloud containers.
 */
export class OracleCacheAndLimiter {
  private readonly l1Cache = new Map<string, CachedResponseEntry>();
  private lastExternalRequestMs = 0;

  isDistributedRedisEnabled(): boolean {
    return Boolean(
      config.cloud.upstashRedisRestUrl && config.cloud.upstashRedisRestToken
    );
  }

  get(key: string, ttlMs = config.resolution.cacheTtlMs): CachedResponseEntry | null {
    const entry = this.l1Cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAtMs >= ttlMs) {
      this.l1Cache.delete(key);
      return null;
    }
    return entry;
  }

  async getDistributed(
    key: string,
    ttlMs = config.resolution.cacheTtlMs
  ): Promise<CachedResponseEntry | null> {
    const localHit = this.get(key, ttlMs);
    if (localHit) return localHit;

    if (!this.isDistributedRedisEnabled()) return null;

    try {
      const redisUrl = `${config.cloud.upstashRedisRestUrl!.replace(/\/$/, '')}/get/${encodeURIComponent(
        `pulseremind:oracle:${key}`
      )}`;
      const res = await fetch(redisUrl, {
        headers: { Authorization: `Bearer ${config.cloud.upstashRedisRestToken}` }
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { result?: string | null };
      if (!data.result) return null;

      const parsed = JSON.parse(data.result) as CachedResponseEntry;
      this.l1Cache.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  set(key: string, entry: Omit<CachedResponseEntry, 'fetchedAtMs'>): void {
    const fullEntry: CachedResponseEntry = {
      ...entry,
      fetchedAtMs: Date.now()
    };
    this.l1Cache.set(key, fullEntry);

    if (this.isDistributedRedisEnabled()) {
      const ttlSeconds = Math.max(1, Math.floor(config.resolution.cacheTtlMs / 1000));
      const redisUrl = `${config.cloud.upstashRedisRestUrl!.replace(/\/$/, '')}/setex/${encodeURIComponent(
        `pulseremind:oracle:${key}`
      )}/${ttlSeconds}`;
      fetch(redisUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.cloud.upstashRedisRestToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fullEntry)
      }).catch(() => {
        // Non-blocking L2 cache write
      });
    }
  }

  clear(): void {
    this.l1Cache.clear();
  }

  async paceRequest(minIntervalMs = config.resolution.minRequestIntervalMs): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastExternalRequestMs;
    if (elapsed < minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
    }
    this.lastExternalRequestMs = Date.now();
  }
}

export const oracleCache = new OracleCacheAndLimiter();
