import { Injectable } from '@nestjs/common';
import { WorkItemRepository } from '@/repositories';
import { DashboardCacheService } from '@/workers/dashboard-cache.service';
import { UpdateStatusDto, IncidentStatus } from '../dto/update-status.dto';
import { StateRegistry } from './states';

/**
 * Workflow Service — State Pattern
 *
 * Each IncidentStatus is represented by a state object (see ./states/).
 * The state object declares its own legal transitions and guards,
 * making invalid transitions structurally impossible.
 *
 * Lifecycle:
 *   OPEN → INVESTIGATING
 *   INVESTIGATING → RESOLVED
 *   RESOLVED → CLOSED (guarded — requires complete RCA)
 *   RESOLVED → INVESTIGATING (reopen)
 *   CLOSED → INVESTIGATING (reopen)
 *
 * Never calls a DB driver directly — all data access via WorkItemRepository.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly workItemRepo: WorkItemRepository,
    private readonly dashboardCache: DashboardCacheService,
  ) {}

  /**
   * Transition an incident to a new status.
   * Delegates validation, guards, and mutation to the current state object.
   */
  async transition(externalId: string, dto: UpdateStatusDto) {
    const client = await this.workItemRepo.getClient();

    try {
      await client.query('BEGIN');

      // Lock the row for update (prevent concurrent transitions)
      const incident = await this.workItemRepo.lockForUpdate(client, externalId);

      if (!incident) {
        throw new Error('Incident not found');
      }

      const currentStatus = incident.status as IncidentStatus;
      const targetStatus = dto.status;

      // 1. Resolve the current state object
      const state = StateRegistry.get(currentStatus);

      // 2. Verify the target is a legal transition from this state
      if (!state.allowedTransitions.includes(targetStatus)) {
        throw new Error(
          `Invalid transition: ${currentStatus} → ${targetStatus}. ` +
          `Allowed: ${state.allowedTransitions.join(', ') || 'none'}`,
        );
      }

      // 3. Delegate execution (guards + DB mutation) to the state object
      await state.execute({
        client,
        incident,
        targetStatus,
        reason: dto.reason || null,
        changedBy: dto.changed_by || 'system',
        workItemRepo: this.workItemRepo,
      });

      // 4. Insert status history
      await this.workItemRepo.insertStatusHistory(
        client,
        incident.id,
        currentStatus,
        targetStatus,
        dto.reason || null,
        dto.changed_by || 'system',
      );

      await client.query('COMMIT');

      // 5. Update state-partitioned dashboard cache
      const severity = incident.severity;
      if (severity) {
        await this.dashboardCache.onStatusChanged(
          externalId,
          currentStatus,
          targetStatus,
          severity,
        );
      }

      // Return updated incident
      return this.workItemRepo.findByExternalId(externalId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

