-- ============================================================
-- IMS - Extend ingest_dedup into an end-to-end processing ledger
-- Adds completion state plus a renewable processing lease for retries.
-- ============================================================

ALTER TABLE ingest_dedup
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'PROCESSING',
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_ingest_dedup_status'
  ) THEN
    ALTER TABLE ingest_dedup
      DROP CONSTRAINT chk_ingest_dedup_status;
  END IF;

  ALTER TABLE ingest_dedup
    ADD CONSTRAINT chk_ingest_dedup_status
    CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED', 'DLQ'));
END $$;

UPDATE ingest_dedup
SET status = COALESCE(status, 'PROCESSING'),
    updated_at = COALESCE(updated_at, NOW())
WHERE status IS NULL OR updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ingest_dedup_status_updated
  ON ingest_dedup (status, updated_at DESC);




