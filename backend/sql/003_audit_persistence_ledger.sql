-- ============================================================
-- IMS - Add standalone audit persistence ledger
-- Tracks the async Mongo audit-write pipeline separately from ingest_dedup.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_signal_persistence (
  signal_id UUID PRIMARY KEY,
  work_item_external_id UUID NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  processing_started_at TIMESTAMPTZ NULL,
  persisted_at TIMESTAMPTZ NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_audit_signal_persistence_status'
  ) THEN
    ALTER TABLE audit_signal_persistence
      DROP CONSTRAINT chk_audit_signal_persistence_status;
  END IF;

  ALTER TABLE audit_signal_persistence
    ADD CONSTRAINT chk_audit_signal_persistence_status
    CHECK (status IN ('PENDING', 'PROCESSING', 'PERSISTED', 'FAILED', 'DLQ'));
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_signal_persistence_status_updated
  ON audit_signal_persistence (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_signal_persistence_work_item
  ON audit_signal_persistence (work_item_external_id, created_at DESC);

