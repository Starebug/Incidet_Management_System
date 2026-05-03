import { Module, Global } from '@nestjs/common';
import { SignalRepository } from './signal.repository';
import { WorkItemRepository } from './work-item.repository';
import { DashboardStateRepository } from './dashboard-state.repository';

/**
 * RepositoriesModule
 *
 * Global module that provides the Repository Pattern layer.
 * Cleanly separates data access from business logic:
 *   - SignalRepository       → MongoDB (signals_raw, dead_letter_queue)
 *   - WorkItemRepository     → PostgreSQL (work_items, status_history, rca_records)
 *   - DashboardStateRepository → Redis (sorted sets + hashes)
 */
@Global()
@Module({
  providers: [SignalRepository, WorkItemRepository, DashboardStateRepository],
  exports: [SignalRepository, WorkItemRepository, DashboardStateRepository],
})
export class RepositoriesModule {}

