import { Injectable } from '@nestjs/common';
import { DashboardStateRepository, WorkItemRepository } from '@/repositories';
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
  constructor(
    private readonly dashboardStateRepo: DashboardStateRepository,
    private readonly workItemRepo: WorkItemRepository,
  ) {}

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
      const summary = await this.workItemRepo.findDashboardSummaryByExternalId(externalId);
      if (!summary) {
        return;
      }

      await this.dashboardStateRepo.addNewIncident(
        externalId,
        this.toSummaryFields(summary),
        summary.severity,
      );
      DebugLogger.log('DashboardCache', 'onIncidentCreated', {
        externalId,
        componentId,
        serviceType,
        severity,
        firstSignalAt,
      });
    } catch (err) {
      console.error('[DashboardCache] onIncidentCreated failed:', err);
    }
  }

  /**
   * Called when an existing incident receives another signal.
   * Refreshes the active dashboard projection from Postgres.
   */
  async onIncidentUpdated(externalId: string): Promise<void> {
    try {
      const summary = await this.workItemRepo.findDashboardSummaryByExternalId(externalId);
      if (!summary || summary.status === 'CLOSED') {
        await this.dashboardStateRepo.removeFromAllStateSets([externalId]);
        await this.dashboardStateRepo.deleteIncidentSummary(externalId);
        return;
      }

      await this.dashboardStateRepo.upsertActiveIncidentProjection(
        summary.status,
        externalId,
        this.toSummaryFields(summary),
        summary.severity,
      );

      DebugLogger.log('DashboardCache', 'onIncidentUpdated', {
        externalId,
        status: summary.status,
        signalCount: summary.signal_count,
      });
    } catch (err) {
      console.error('[DashboardCache] onIncidentUpdated failed:', err);
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
      if (newStatus === 'CLOSED') {
        await this.dashboardStateRepo.moveIncidentState(externalId, oldStatus, newStatus, null);
      } else {
        const summary = await this.workItemRepo.findDashboardSummaryByExternalId(externalId);
        if (!summary) {
          await this.dashboardStateRepo.removeFromAllStateSets([externalId]);
          await this.dashboardStateRepo.deleteIncidentSummary(externalId);
          return;
        }

        await this.dashboardStateRepo.moveIncidentState(
          externalId,
          oldStatus,
          newStatus,
          this.toSummaryFields(summary),
          summary.severity,
        );
      }

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

  private toSummaryFields(summary: {
    external_id: string;
    component_id: string;
    service_type: string;
    severity: string;
    status: string;
    first_signal_at: Date | string;
    last_signal_at: Date | string;
    signal_count: number | string;
    updated_at: Date | string;
  }): Record<string, string> {
    return {
      external_id: summary.external_id,
      component_id: summary.component_id,
      service_type: summary.service_type,
      severity: summary.severity,
      status: summary.status,
      first_signal_at: this.normalizeDate(summary.first_signal_at),
      last_signal_at: this.normalizeDate(summary.last_signal_at),
      signal_count: String(summary.signal_count),
      updated_at: this.normalizeDate(summary.updated_at),
    };
  }

  private normalizeDate(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : String(value);
  }
}
