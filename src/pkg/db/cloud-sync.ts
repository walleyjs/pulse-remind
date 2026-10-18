import { config } from '../../config/index.ts';
import { oracleCache } from '../cache/oracle-cache.ts';

export interface InfrastructureStatus {
  mode: 'local_embedded' | 'cloud_hybrid';
  primaryDatabase: 'node:sqlite' | 'supabase_postgres' | 'turso_libsql';
  cacheBackend: 'in_memory_l1' | 'upstash_redis_l2';
  headlessScraper: 'native_fetch' | 'firecrawl_headless';
}

/**
 * Dual-Mode Cloud Sync Adapter:
 * - Locally & in CI tests (`PULSEREMIND_DB_PATH=:memory:`), uses zero-setup built-in `node:sqlite`.
 * - In Cloud Production (`SUPABASE_URL` or `TURSO_DATABASE_URL` configured), replicates write
 *   mutations asynchronously to managed PostgreSQL (Supabase PostgREST) or Distributed SQLite (Turso HTTP pipeline).
 */
export class CloudDatabaseSync {
  getStatus(): InfrastructureStatus {
    const isCloudDb = config.cloud.storageProvider !== 'sqlite';
    const isRedis = oracleCache.isDistributedRedisEnabled();
    const isFirecrawl = Boolean(config.cloud.firecrawlApiKey);

    return {
      mode: isCloudDb || isRedis ? 'cloud_hybrid' : 'local_embedded',
      primaryDatabase:
        config.cloud.storageProvider === 'supabase'
          ? 'supabase_postgres'
          : config.cloud.storageProvider === 'turso'
            ? 'turso_libsql'
            : 'node:sqlite',
      cacheBackend: isRedis ? 'upstash_redis_l2' : 'in_memory_l1',
      headlessScraper: isFirecrawl ? 'firecrawl_headless' : 'native_fetch'
    };
  }

  async replicateRow(table: string, payload: Record<string, unknown>): Promise<boolean> {
    if (config.cloud.storageProvider === 'supabase' && config.cloud.supabaseUrl && config.cloud.supabaseKey) {
      try {
        const res = await fetch(`${config.cloud.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}`, {
          method: 'POST',
          headers: {
            apikey: config.cloud.supabaseKey,
            Authorization: `Bearer ${config.cloud.supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify(payload)
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    if (config.cloud.storageProvider === 'turso' && config.cloud.tursoUrl && config.cloud.tursoAuthToken) {
      try {
        const cols = Object.keys(payload);
        const placeholders = cols.map(() => '?').join(', ');
        const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
        const args = cols.map((k) => ({
          type: typeof payload[k] === 'number' ? 'integer' : 'text',
          value: payload[k] === null || payload[k] === undefined ? null : String(payload[k])
        }));

        const res = await fetch(`${config.cloud.tursoUrl.replace(/\/$/, '')}/v2/pipeline`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.cloud.tursoAuthToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }]
          })
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    return false;
  }
}

export const cloudDatabaseSync = new CloudDatabaseSync();
