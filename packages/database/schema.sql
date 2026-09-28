-- Postgres schema for the persistent AttemptStore (Phase 6 wiring).
-- The executor only depends on the AttemptStore interface, so swapping
-- InMemoryAttemptStore for this backend requires no pipeline changes.

CREATE TABLE IF NOT EXISTS mint_attempts (
  id              UUID PRIMARY KEY,
  collection      TEXT NOT NULL,
  chain           TEXT NOT NULL,
  wallet          TEXT,
  quantity        INTEGER NOT NULL,
  price_wei       NUMERIC(78, 0) NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('detected','skipped','dry_run','pending','confirmed','failed','unknown')),
  reason          TEXT,
  tx_hash         TEXT,
  block_number    BIGINT,
  error           TEXT,
  trace           JSONB NOT NULL DEFAULT '{}',
  latencies       JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mint_attempts_collection
  ON mint_attempts (collection, status);
CREATE INDEX IF NOT EXISTS idx_mint_attempts_created
  ON mint_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mint_attempts_tx
  ON mint_attempts (tx_hash) WHERE tx_hash IS NOT NULL;

-- Encrypted wallet secrets land here in the multi-wallet phase.
-- Private keys are stored AES-256-GCM encrypted and are never
-- selectable through the API.
CREATE TABLE IF NOT EXISTS wallets (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  address         TEXT NOT NULL,
  encrypted_key   BYTEA,
  key_nonce       BYTEA,
  daily_spend_cap NUMERIC(78, 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
