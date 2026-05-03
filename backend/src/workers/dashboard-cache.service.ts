import { Injectable } from '@nestjs/common';
import { DashboardStateRepository } from '@/repositories';
import { DebugLogger } from '@/common/utils/debug-logger';

/**
 * DashboardCacheService
 *
 * Manages the Redis hot-path cache for the live dashboard.
 * Delegates all Redis operations to DashboardStateRepository.
 * Contains only orchestration logic — no direct DB driver calls.
 */
@Injectable()
export class DashboardCacheService {
  constructor(private readonly dashboardStateRepo: DashboardStateRepository) {}

  /**
   * Called after a new work item is created by the signal worker.
   * Adds the incident to the OPEN state set and writes its summary hash.
   */
  async onIncidentCreated(
    externalId: string,
    componentId: string,
    serviceType: string,
    severity: string,
    firstSignalAt: string,
  ): Promise<void> {
    try {
      await this.dashboardStateRepo.addNewIncident(
        externalId,
        {
          external_id: externalId,
          component_id: componentId,
          service_type: serviceType,
          severity,
          status: 'OPEN',
          first_signal_at: firstSignalAt,
          updated_at: new Date().toISOString(),
        },
        severity,
      );
      DebugLogger.log('DashboardCache', 'onIncidentCreated', {
        externalId,
        componentId,
        serviceType,
        severity,
      });
    } catch (err) {
      console.error('[DashboardCache] onIncidentCreated failed:', err);
    }
  }

  /**
   * Called after a signal is linked to an existing work item.
   * Refreshes the incident hash TTL and updated_at.
   */
  async onSignalProcessed(
    externalId: string,
    severity: string,
    isNew: boolean,
  ): Promise<void> {
    try {
      if (isNew) {
        return;
      }

      await this.dashboardStateRepo.updateIncidentFields(externalId, {
        updated_at: new Date().toISOString(),
      });
      DebugLogger.log('DashboardCache', 'onSignalProcessed', {
        externalId,
        severity,
        isNew,
      });
    } catch (err) {
      console.error('[DashboardCache] onSignalProcessed failed:', err);
    }
  }

  /**
   * Called when an incident status transitions.
   * Moves the incident between state-partitioned sorted sets.
   */
  async onStatusChanged(
    externalId: string,
    oldStatus: string,
    newStatus: string,
    severity: string,
  ): Promise<void> {
    try {
      await this.dashboardStateRepo.moveIncidentState(externalId, oldStatus, newStatus, severity);
      DebugLogger.log('DashboardCache', 'onStatusChanged', {
        externalId,
        oldStatus,
        newStatus,
        severity,
      });
    } catch (err) {
      console.error('[DashboardCache] onStatusChanged failed:', err);
    }
  }
}
