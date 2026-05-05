import { Module, Global } from '@nestjs/common';
import { SignalRepository } from './signal.repository';
import { WorkItemRepository } from './work-item.repository';
import { DashboardStateRepository } from './dashboard-state.repository';
import { IngestLedgerRepository } from './ingest-ledger.repository';
import { AuditPersistenceRepository } from './audit-persistence.repository';

/**
 * RepositoriesModule
 *
 * Global module that provides the Repository Pattern layer.
 * Cleanly separates data access from business logic:
 *   - SignalRepository       → MongoDB (signals_raw, dead_letter_queue)
 *   - WorkItemRepository     → PostgreSQL (work_items, status_history, rca_records)
 *   - IngestLedgerRepository → PostgreSQL (end-to-end signal processing state)
 *   - AuditPersistenceRepository → PostgreSQL (async Mongo audit persistence state)
 *   - DashboardStateRepository → Redis (sorted sets + hashes)
 */
@Global()
@Module({
  providers: [
    SignalRepository,
    WorkItemRepository,
    IngestLedgerRepository,
    AuditPersistenceRepository,
    DashboardStateRepository,
  ],
  exports: [
    SignalRepository,
    WorkItemRepository,
    IngestLedgerRepository,
    AuditPersistenceRepository,
    DashboardStateRepository,
  ],
})
export class RepositoriesModule {}

