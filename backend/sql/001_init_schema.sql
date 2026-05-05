-- ============================================================
-- Incident Management System (IMS) - PostgreSQL Schema
-- Source of Truth: Work Items, RCA, Status History
-- ============================================================

-- Drop existing types if recreating (dev only)
-- DROP TYPE IF EXISTS incident_status CASCADE;
-- DROP TYPE IF EXISTS severity_level CASCADE;

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE incident_status AS ENUM (
  'OPEN',
  'INVESTIGATING',
  'RESOLVED',
  'CLOSED'
);

CREATE TYPE severity_level AS ENUM (
  'P0',  -- Critical (e.g., RDBMS failure)
  'P1',  -- High
  'P2',  -- Medium (e.g., Cache failure)
  'P3'   -- Low
);

CREATE TYPE service_type AS ENUM (
  'API',
  'MCP_HOST',
  'DISTRIBUTED_CACHE',
  'ASYNC_QUEUE',
  'RDBMS',
  'NOSQL'
);

-- ============================================================
-- WORK ITEMS (Core Incident Table)
-- ============================================================

CREATE TABLE work_items (
  id BIGSERIAL PRIMARY KEY,

  -- Public identifier for API/UI (sharding-friendly)
  external_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  -- Component that triggered the incident
  component_id VARCHAR(128) NOT NULL,
  service_type service_type NOT NULL,

  -- Severity and workflow state
  severity severity_level NOT NULL,
  status incident_status NOT NULL DEFAULT 'OPEN',

  -- Signal timing
  first_signal_at TIMESTAMPTZ NOT NULL,
  last_signal_at TIMESTAMPTZ NOT NULL,
  signal_count INTEGER NOT NULL DEFAULT 1,

  -- Resolution timing
  closed_at TIMESTAMPTZ NULL,
  mttr_seconds INTEGER NULL,

  -- Optimistic concurrency control
  version INTEGER NOT NULL DEFAULT 1,

  -- Audit timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for dashboard live feed (active incidents sorted by severity)
CREATE INDEX idx_work_items_active_feed
  ON work_items (status, severity, updated_at DESC)
  WHERE status != 'CLOSED';

-- Index for component-based queries
CREATE INDEX idx_work_items_component
  ON work_items (component_id, created_at DESC);

-- Index for debounce lookups (recent open by component)
CREATE INDEX idx_work_items_debounce_lookup
  ON work_items (component_id, status, created_at DESC)
  WHERE status = 'OPEN';

-- ============================================================
-- RCA RECORDS (Root Cause Analysis)
-- ============================================================

CREATE TABLE rca_records (
  id BIGSERIAL PRIMARY KEY,

  -- One RCA per work item
  work_item_id BIGINT NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,

  -- RCA required fields
  incident_start TIMESTAMPTZ NOT NULL,
  incident_end TIMESTAMPTZ NOT NULL,
  root_cause_category VARCHAR(64) NOT NULL,
  fix_applied TEXT NOT NULL,
  prevention_steps TEXT NOT NULL,

  -- Audit
  created_by VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Validation: end must be >= start
  CONSTRAINT chk_rca_time_order CHECK (incident_end >= incident_start),

  -- Validation: required text fields are non-empty
  CONSTRAINT chk_rca_fix_applied_nonempty CHECK (LENGTH(TRIM(fix_applied)) > 0),
  CONSTRAINT chk_rca_prevention_nonempty CHECK (LENGTH(TRIM(prevention_steps)) > 0)
);

-- Index for checking RCA existence during close validation
CREATE INDEX idx_rca_work_item ON rca_records (work_item_id);

-- ============================================================
-- STATUS HISTORY (Workflow Audit Trail)
-- ============================================================

CREATE TABLE status_history (
  id BIGSERIAL PRIMARY KEY,

  work_item_id BIGINT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,

  from_status incident_status NULL,  -- NULL for initial creation
  to_status incident_status NOT NULL,

  reason TEXT NULL,
  changed_by VARCHAR(128) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for timeline queries
CREATE INDEX idx_status_history_timeline
  ON status_history (work_item_id, changed_at DESC);

-- ============================================================
-- INGEST LEDGER (Idempotency / Processing State)
-- ============================================================

CREATE TABLE ingest_dedup (
  signal_id UUID PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(32) NOT NULL DEFAULT 'PROCESSING',
  processing_started_at TIMESTAMPTZ NULL,
  processed_at TIMESTAMPTZ NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ingest_dedup_status
    CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED', 'DLQ'))
);

-- TTL cleanup: remove entries older than 1 hour via scheduled job
-- (Postgres doesn't have native TTL; use pg_cron or app-level cleanup)
CREATE INDEX idx_ingest_dedup_ttl ON ingest_dedup (received_at);

-- Processing-state lookup for retries, stuck work, and repair tooling
CREATE INDEX idx_ingest_dedup_status_updated
  ON ingest_dedup (status, updated_at DESC);

-- ============================================================
-- AUDIT PERSISTENCE LEDGER (Async Mongo Audit Write State)
-- ============================================================

CREATE TABLE audit_signal_persistence (
  signal_id UUID PRIMARY KEY,
  work_item_external_id UUID NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  processing_started_at TIMESTAMPTZ NULL,
  persisted_at TIMESTAMPTZ NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_audit_signal_persistence_status
    CHECK (status IN ('PENDING', 'PROCESSING', 'PERSISTED', 'FAILED', 'DLQ'))
);

CREATE INDEX idx_audit_signal_persistence_status_updated
  ON audit_signal_persistence (status, updated_at DESC);

CREATE INDEX idx_audit_signal_persistence_work_item
  ON audit_signal_persistence (work_item_external_id, created_at DESC);

-- ============================================================
-- AGGREGATIONS (Time-series Metrics)
-- ============================================================

CREATE TABLE incident_metrics_1m (
  bucket_start TIMESTAMPTZ NOT NULL,
  component_id VARCHAR(128) NOT NULL,
  service_type service_type NOT NULL,
  severity severity_level NOT NULL,

  signals_count INTEGER NOT NULL DEFAULT 0,
  incidents_opened INTEGER NOT NULL DEFAULT 0,
  incidents_closed INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (bucket_start, component_id, service_type, severity)
);

-- Index for dashboard time-range queries
CREATE INDEX idx_metrics_time_range
  ON incident_metrics_1m (bucket_start DESC, service_type, severity);

-- ============================================================
-- FUNCTIONS: Auto-update updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_work_items_updated_at
  BEFORE UPDATE ON work_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_rca_records_updated_at
  BEFORE UPDATE ON rca_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- COMMENTS (Documentation)
-- ============================================================

COMMENT ON TABLE work_items IS 'Source of truth for incident/work item lifecycle';
COMMENT ON TABLE rca_records IS 'Root Cause Analysis records - required before closing incidents';
COMMENT ON TABLE status_history IS 'Audit trail of all status transitions';
COMMENT ON TABLE ingest_dedup IS 'Signal ingestion ledger for idempotency and end-to-end processing completion';
COMMENT ON TABLE audit_signal_persistence IS 'Async audit-persistence ledger for Mongo raw signal writes';
COMMENT ON TABLE incident_metrics_1m IS 'Pre-aggregated time-series metrics for dashboard';

COMMENT ON COLUMN work_items.external_id IS 'Public UUID for API/UI - never expose internal id';
COMMENT ON COLUMN work_items.mttr_seconds IS 'Mean Time To Repair: incident_end - first_signal_at';
COMMENT ON COLUMN work_items.version IS 'Optimistic locking version for concurrent updates';

