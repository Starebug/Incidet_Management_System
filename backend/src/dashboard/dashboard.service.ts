import { Injectable } from '@nestjs/common';
import { WorkItemRepository } from '@/repositories';
import { DashboardStateRepository } from '@/repositories';
import { DebugLogger } from '../common/utils/debug-logger';

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
    if (status && ['OPEN', 'INVESTIGATING', 'RESOLVED'].includes(status)) {
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
        const incidents = await this.dashboardStateRepo.loadIncidentSummaries(ids);
        this.logTiming(`Redis summaries for ${status}`, summariesStartedAt, {
          requestedIds: ids.length,
          loadedIncidents: incidents.length,
        });

        if (incidents.length > 0) {
          DebugLogger.log('Dashboard', `Cache HIT for status=${status} count=${incidents.length}`);
          return {
            incidents,
            status,
            count: incidents.length,
            source: 'cache',
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
        const incidents = await this.dashboardStateRepo.loadIncidentSummaries(allIds);
        this.logTiming('Redis summaries for ALL states', summariesStartedAt, {
          requestedIds: allIds.length,
          loadedIncidents: incidents.length,
        });
        if (incidents.length > 0) {
          DebugLogger.log('Dashboard', `Cache HIT for status=ALL count=${incidents.length}`);
          return {
            incidents,
            status: 'ALL',
            count: incidents.length,
            source: 'cache',
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
  private async getLiveFeedFromPostgres(status?: string) {
    const pgStartedAt = Date.now();

    const rows = await this.workItemRepo.findLiveFeed(status, 100);
    this.logTiming(`Postgres live feed query (${status || 'ALL'})`, pgStartedAt, {
      rows: rows.length,
    });

    // Warm cache asynchronously (fire and forget)
    this.dashboardStateRepo.warmCache(rows).catch(() => {});

    return {
      incidents: rows,
      status: status || 'ALL',
      count: rows.length,
      source: 'postgres',
      refreshed_at: new Date().toISOString(),
    };
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
}
