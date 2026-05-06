import { Injectable } from '@nestjs/common';
import { DashboardIncidentCacheEntry, DashboardStateRepository, WorkItemRepository } from '@/repositories';
import { DebugLogger } from '@/common/utils/debug-logger';

/**
 * DashboardService
 *
 * State-partitioned caching strategy:
 *   Read path:  DashboardStateRepository (Redis) first → WorkItemRepository (Postgres) fallback
 *   Write path: Workers/workflow update Redis on signal/status changes
 *
 * Never calls a DB driver directly — all data access via repositories.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly workItemRepo: WorkItemRepository,
    private readonly dashboardStateRepo: DashboardStateRepository,
  ) {}

  /**
   * Get live feed for a specific status tab (or all active if undefined).
   * Redis-first with Postgres fallback.
   */
  async getLiveFeed(status?: string) {
    const startedAt = Date.now();
    if (status === 'CLOSED') {
      const result = await this.getLiveFeedFromPostgres(status, { warmCache: false });
      this.logTiming(`getLiveFeed(status=${status}) total`, startedAt, {
        source: result.source,
        count: result.count,
      });
      return result;
    }

    if (status && this.isActiveStatus(status)) {
      const result = await this.getLiveFeedByStatus(status);
      this.logTiming(`getLiveFeed(status=${status}) total`, startedAt, {
        source: result.source,
        count: result.count,
      });
      return result;
    }
    const result = await this.getLiveFeedAllActive();
    this.logTiming('getLiveFeed(status=ALL) total', startedAt, {
      source: result.source,
      count: result.count,
    });
    return result;
  }

  /**
   * Single-status tab: try Redis cache, fallback to Postgres.
   */
  private async getLiveFeedByStatus(status: string) {
    const cacheReadStartedAt = Date.now();

    try {
      const ids = await this.dashboardStateRepo.getIdsByStatus(status, 0, 99);
      this.logTiming(`Redis zrange for ${status}`, cacheReadStartedAt, {
        ids: ids?.length || 0,
      });

      if (ids && ids.length > 0) {
        const summariesStartedAt = Date.now();
        const { incidents, missingIds } = await this.dashboardStateRepo.loadIncidentSummaries(ids);
        const validIncidents = incidents.filter((incident) => incident.status === status);
        const mismatchedIds = incidents
          .filter((incident) => incident.status !== status)
          .map((incident) => incident.external_id);
        const unresolvedIds = [...missingIds, ...mismatchedIds];
        this.logTiming(`Redis summaries for ${status}`, summariesStartedAt, {
          requestedIds: ids.length,
          loadedIncidents: validIncidents.length,
          missingIds: unresolvedIds.length,
        });

        if (unresolvedIds.length === 0 && validIncidents.length > 0) {
          DebugLogger.log('Dashboard', `Cache HIT for status=${status} count=${validIncidents.length}`);
          return {
            incidents: validIncidents,
            status,
            count: validIncidents.length,
            source: 'cache',
            refreshed_at: new Date().toISOString(),
          };
        }

        const repaired = await this.reconcileCachedIncidents(ids, validIncidents, unresolvedIds, status);
        if (repaired.length > 0) {
          DebugLogger.log('Dashboard', `Cache PARTIAL HIT repaired for status=${status} count=${repaired.length}`);
          return {
            incidents: repaired,
            status,
            count: repaired.length,
            source: 'cache+backfill',
            refreshed_at: new Date().toISOString(),
          };
        }
      }

      DebugLogger.log('Dashboard', `Cache MISS for status=${status}`);
    } catch (err) {
      console.error('[Dashboard] Redis cache read failed, falling back to Postgres:', err);
    }

    return this.getLiveFeedFromPostgres(status);
  }

  /**
   * All active incidents (no specific tab selected).
   */
  private async getLiveFeedAllActive() {
    const cacheReadStartedAt = Date.now();
    try {
      const allIds = await this.dashboardStateRepo.getAllActiveIds(50);
      this.logTiming('Redis zrange for ALL states', cacheReadStartedAt, {
        totalIds: allIds.length,
      });

      if (allIds.length > 0) {
        const summariesStartedAt = Date.now();
        const { incidents, missingIds } = await this.dashboardStateRepo.loadIncidentSummaries(allIds);
        const validIncidents = incidents.filter((incident) => this.isActiveStatus(incident.status));
        const mismatchedIds = incidents
          .filter((incident) => !this.isActiveStatus(incident.status))
          .map((incident) => incident.external_id);
        const unresolvedIds = [...missingIds, ...mismatchedIds];
        this.logTiming('Redis summaries for ALL states', summariesStartedAt, {
          requestedIds: allIds.length,
          loadedIncidents: validIncidents.length,
          missingIds: unresolvedIds.length,
        });
        if (unresolvedIds.length === 0 && validIncidents.length > 0) {
          DebugLogger.log('Dashboard', `Cache HIT for status=ALL count=${validIncidents.length}`);
          return {
            incidents: validIncidents,
            status: 'ALL',
            count: validIncidents.length,
            source: 'cache',
            refreshed_at: new Date().toISOString(),
          };
        }

        const repaired = await this.reconcileCachedIncidents(allIds, validIncidents, unresolvedIds);
        if (repaired.length > 0) {
          DebugLogger.log('Dashboard', `Cache PARTIAL HIT repaired for status=ALL count=${repaired.length}`);
          return {
            incidents: repaired,
            status: 'ALL',
            count: repaired.length,
            source: 'cache+backfill',
            refreshed_at: new Date().toISOString(),
          };
        }
      }

      DebugLogger.log('Dashboard', 'Cache MISS for status=ALL');
    } catch (err) {
      console.error('[Dashboard] Redis cache read failed:', err);
    }

    return this.getLiveFeedFromPostgres(undefined);
  }

  /**
   * Postgres fallback query. Optionally warm the cache from results.
   */
  private async getLiveFeedFromPostgres(status?: string, options?: { warmCache?: boolean }) {
    const pgStartedAt = Date.now();

    const rows = await this.workItemRepo.findLiveFeed(status, 100);
    this.logTiming(`Postgres live feed query (${status || 'ALL'})`, pgStartedAt, {
      rows: rows.length,
    });

    if (options?.warmCache ?? true) {
      // Warm cache asynchronously (fire and forget)
      this.dashboardStateRepo.warmCache(rows).catch(() => {});
    }

    return {
      incidents: rows,
      status: status || 'ALL',
      count: rows.length,
      source: 'postgres',
      refreshed_at: new Date().toISOString(),
    };
  }

  private async reconcileCachedIncidents(
    ids: string[],
    cachedIncidents: DashboardIncidentCacheEntry[],
    missingIds: string[],
    status?: string,
  ): Promise<any[]> {
    if (ids.length === 0) {
      return [];
    }

    if (missingIds.length === 0) {
      return cachedIncidents;
    }

    await this.dashboardStateRepo.removeFromAllStateSets(missingIds).catch(() => {});

    const backfilledRows = await this.workItemRepo.findDashboardSummariesByExternalIds(missingIds, status);
    if (backfilledRows.length > 0) {
      await this.dashboardStateRepo.warmCache(backfilledRows).catch(() => {});
    }

    const recoveredIds = new Set(backfilledRows.map((row) => row.external_id));
    const staleIds = missingIds.filter((id) => !recoveredIds.has(id));
    if (staleIds.length > 0) {
      DebugLogger.log('Dashboard', 'Pruned stale dashboard cache IDs', {
        status: status || 'ALL',
        staleIds,
      });
    }

    const incidentById = new Map<string, any>();
    for (const incident of cachedIncidents) {
      incidentById.set(incident.external_id, incident);
    }
    for (const row of backfilledRows) {
      incidentById.set(row.external_id, row);
    }

    return ids
      .map((id) => incidentById.get(id))
      .filter((incident): incident is any => Boolean(incident));
  }

  /**
   * Aggregated dashboard statistics.
   */
  async getStats() {
    const stats = await this.workItemRepo.getStats();

    return {
      by_status: stats.statusCounts,
      by_severity: stats.severityCounts,
      mttr: stats.mttrStats,
      recent_closed: stats.recentClosed,
    };
  }

  private logTiming(operation: string, startedAt: number, meta?: Record<string, unknown>) {
    const durationMs = Date.now() - startedAt;
    if (meta) {
      DebugLogger.log('Dashboard', `${operation} took ${durationMs}ms`, meta);
      return;
    }
    DebugLogger.log('Dashboard', `${operation} took ${durationMs}ms`);
  }

  private isActiveStatus(status: string): boolean {
    return ['OPEN', 'INVESTIGATING', 'RESOLVED'].includes(status);
  }
}
