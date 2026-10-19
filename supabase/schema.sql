-- ============================================================================
-- PulseRemind — Supabase PostgreSQL Schema
-- Copy and paste this entire script into the Supabase SQL Editor -> Click "Run"
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.watches (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'scholarship',
  chat_context TEXT NOT NULL,
  source_chat_client TEXT NOT NULL DEFAULT 'MCP Client',
  target_url TEXT,
  secondary_url TEXT,
  canonical_url_key TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'web_monitor',
  condition_text TEXT NOT NULL,
  expected_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  closed_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  window_start_date TEXT,
  window_label TEXT,
  check_interval_minutes INTEGER NOT NULL DEFAULT 60,
  poll_after BIGINT NOT NULL DEFAULT 0,
  is_auto_resolve BOOLEAN NOT NULL DEFAULT true,
  proposed_outcome INTEGER,
  closing_soon_notified BOOLEAN NOT NULL DEFAULT false,
  resolution_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  oracle_responses JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active_monitoring',
  notify_channels JSONB NOT NULL DEFAULT '["in_app","email"]'::jsonb,
  recipient_email TEXT,
  last_checked_at TIMESTAMPTZ,
  last_snapshot_hash TEXT,
  last_status_summary TEXT,
  detected_deadline TEXT,
  detected_apply_url TEXT,
  triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watches_status_pollafter
  ON public.watches (status, poll_after);

CREATE INDEX IF NOT EXISTS idx_watches_canonical_url
  ON public.watches (canonical_url_key);

CREATE TABLE IF NOT EXISTS public.check_logs (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES public.watches(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  http_status INTEGER,
  is_open BOOLEAN NOT NULL DEFAULT false,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  extracted_snippet TEXT,
  page_changed BOOLEAN NOT NULL DEFAULT false,
  oracle_name TEXT NOT NULL DEFAULT 'web_portal',
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  entity_validated BOOLEAN NOT NULL DEFAULT true,
  next_poll_after BIGINT
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  watch_title TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'delivered',
  preview_url TEXT,
  idempotency_key TEXT UNIQUE,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reload PostgREST schema cache immediately so /rest/v1/watches is live
NOTIFY pgrst, 'reload schema';
