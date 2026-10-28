import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadDotEnvIfPresent(): void {
  if (process.env.NODE_ENV === 'test' || process.env.PULSEREMIND_DB_PATH === ':memory:') {
    return;
  }
  const candidatePaths = [
    path.join(process.cwd(), '.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env')
  ];

  for (const envPath of candidatePaths) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key] && val) {
              process.env[key] = val;
            }
          }
        }
        break;
      }
    } catch {
      // Ignore in read-only / custom environments
    }
  }
}

export interface CloudInfrastructureConfig {
  storageProvider: 'sqlite' | 'supabase';
  supabaseUrl: string | null;
  supabaseKey: string | null;
  upstashRedisRestUrl: string | null;
  upstashRedisRestToken: string | null;
  firecrawlApiKey: string | null;
  renderExternalUrl: string | null;
  cronSecret: string | null;
  keepAliveIntervalMs: number;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  defaultRecipientEmail: string;
  resolution: {
    schedulerIntervalMs: number;
    cacheTtlMs: number;
    minRequestIntervalMs: number;
    httpTimeoutMs: number;
    transientBackoffSeconds: number;
    entityMismatchBackoffSeconds: number;
    preWindowWakeDays: number;
    closingSoonDaysThreshold: number;
  };
  cloud: CloudInfrastructureConfig;
}

export function loadConfig(): AppConfig {
  loadDotEnvIfPresent();

  const supabaseUrl = process.env.SUPABASE_URL || null;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;

  const requestedProvider = (process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
  let storageProvider: 'sqlite' | 'supabase' = 'sqlite';

  // Explicit Supabase activation requires valid credentials
  if (requestedProvider === 'supabase') {
    if (supabaseUrl && supabaseKey) {
      storageProvider = 'supabase';
    } else {
      console.warn('[Config] STORAGE_PROVIDER=supabase requested but missing SUPABASE_URL or key. Falling back to hermetic sqlite.');
      storageProvider = 'sqlite';
    }
  } else if (!requestedProvider && supabaseUrl && supabaseKey && process.env.PULSEREMIND_DB_PATH !== ':memory:') {
    // Cloud hybrid mode if credentials exist and not in-memory test
    storageProvider = 'supabase';
  }

  return {
    port: Number(process.env.PORT || 3456),
    dbPath:
      process.env.PULSEREMIND_DB_PATH ||
      path.join(process.cwd(), 'data', 'pulseremind.db'),
    defaultRecipientEmail:
      process.env.DEFAULT_RECIPIENT_EMAIL || '',
    resolution: {
      schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60_000),
      cacheTtlMs: Number(process.env.ORACLE_CACHE_TTL_MS || 120_000),
      minRequestIntervalMs: Number(process.env.ORACLE_RATE_PACE_MS || 300),
      httpTimeoutMs: Number(process.env.ORACLE_HTTP_TIMEOUT_MS || 12_000),
      transientBackoffSeconds: 900, // 15 minutes (Octopus pattern)
      entityMismatchBackoffSeconds: 86_400, // 24 hours + auto_resolve paused
      preWindowWakeDays: 14,
      closingSoonDaysThreshold: 14
    },
    cloud: {
      storageProvider,
      supabaseUrl,
      supabaseKey,
      upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL || null,
      upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN || null,
      firecrawlApiKey: process.env.FIRECRAWL_API_KEY || null,
      // Render automatically injects RENDER_EXTERNAL_URL; default to live production URL when not running in-memory tests
      renderExternalUrl:
        process.env.RENDER_EXTERNAL_URL ||
        process.env.PUBLIC_APP_URL ||
        (process.env.PULSEREMIND_DB_PATH === ':memory:' ? null : 'https://pulse-remind.onrender.com'),
      cronSecret: process.env.CRON_SECRET || null,
      keepAliveIntervalMs: Number(process.env.KEEPALIVE_INTERVAL_MS || 13 * 60 * 1000) // 13 mins (< Render's 15m idle sleep)
    }
  };
}

export const config = loadConfig();
