import { Injectable } from '@nestjs/common';
import { PostgresService } from '../common/database/postgres.service';
import { RedisService } from '../common/redis/redis.service';

/**
 * DashboardService
 *
 * State-partitioned caching strategy:
 *   Redis keys:
 *     dashboard:open           — ZSET of external_ids (score = severity rank)
 *     dashboard:investigating  — ZSET of external_ids
 *     dashboard:resolved       — ZSET of external_ids
 *     incident:{external_id}   — HASH with summary fields
 *
 *   Read path:  Redis first → Postgres fallback
 *   Write path: Workers/workflow update Redis on signal/status changes
 */
@Injectable()
export class DashboardService {
  private readonly STATE_KEYS: Record<string, string> = {
    OPEN: 'dashboard:open',
    INVESTIGATING: 'dashboard:investigating',
    RESOLVED: 'dashboard:resolved',
  };

  private readonly INCIDENT_TTL = 300; // 5 min TTL for incident hashes

  constructor(
    private readonly pg: PostgresService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Get live feed for a specific status tab (or all active if undefined).
   * Redis-first with Postgres fallback.
   */
  async getLiveFeed(status?: string) {
    if (status && this.STATE_KEYS[status]) {
      return this.getLiveFeedByStatus(status);
    }
    // No specific status = return all active (for backward compat)
    return this.getLiveFeedAllActive();
  }

  /**
   * Single-status tab: try Redis cache, fallback to Postgres.
   */
  private async getLiveFeedByStatus(status: string) {
    const cacheKey = this.STATE_KEYS[status];

    try {
      // Step 1: Get incident IDs from state-specific sorted set
      const ids = await this.redis.client.zrange(cacheKey, 0, 99);

      if (ids && ids.length > 0) {
        // Step 2: Load incident summaries from Redis hashes
        const incidents = await this.loadIncidentSummaries(ids);

        if (incidents.length > 0) {
          return {
            incidents,
            status,
            count: incidents.length,
            source: 'cache',
            refreshed_at: new Date().toISOString(),
          };
        }
      }
    } catch (err) {
      // Redis failure → fall through to Postgres
      console.error('[Dashboard] Redis cache read failed, falling back to Postgres:', err);
    }

    // Fallback: Postgres query
    return this.getLiveFeedFromPostgres(status);
  }

  /**
   * All active incidents (no specific tab selected).
   */
  private async getLiveFeedAllActive() {
    // Try loading all three states from Redis
    try {
      const [openIds, investigatingIds, resolvedIds] = await Promise.all([
        this.redis.client.zrange(this.STATE_KEYS.OPEN, 0, 49),
        this.redis.client.zrange(this.STATE_KEYS.INVESTIGATING, 0, 49),
        this.redis.client.zrange(this.STATE_KEYS.RESOLVED, 0, 49),
      ]);

      const allIds = [...(openIds || []), ...(investigatingIds || []), ...(resolvedIds || [])];

      if (allIds.length > 0) {
        const incidents = await this.loadIncidentSummaries(allIds);
        if (incidents.length > 0) {
          return {
            incidents,
            status: 'ALL',
            count: incidents.length,
            source: 'cache',
            refreshed_at: new Date().toISOString(),
          };
        }
      }
    } catch (err) {
      console.error('[Dashboard] Redis cache read failed:', err);
    }

    // Fallback
    return this.getLiveFeedFromPostgres(undefined);
  }

  /**
   * Postgres fallback query. Optionally warm the cache from results.
   */
  private async getLiveFeedFromPostgres(status?: string) {
    const statusFilter = status
      ? `WHERE status = '${status}'`
      : `WHERE status != 'CLOSED'`;

    const result = await this.pg.query(
      `SELECT external_id, component_id, service_type, severity, status,
              first_signal_at, last_signal_at, signal_count, updated_at
       FROM work_items
       ${statusFilter}
       ORDER BY
         CASE severity
           WHEN 'P0' THEN 0
           WHEN 'P1' THEN 1
           WHEN 'P2' THEN 2
           WHEN 'P3' THEN 3
         END ASC,
         updated_at DESC
       LIMIT 100`,
    );

    // Warm cache asynchronously (fire and forget)
    this.warmCache(result.rows).catch(() => {});

    return {
      incidents: result.rows,
      status: status || 'ALL',
      count: result.rows.length,
      source: 'postgres',
      refreshed_at: new Date().toISOString(),
    };
  }

  /**
   * Load incident summary hashes from Redis.
   * Filters out any missing/expired entries.
   */
  private async loadIncidentSummaries(ids: string[]): Promise<any[]> {
    const pipeline = this.redis.client.pipeline();
    for (const id of ids) {
      pipeline.hgetall(`incident:${id}`);
    }

    const results = await pipeline.exec();
    if (!results) return [];

    const incidents: any[] = [];
    for (const [err, data] of results) {
      if (!err && data && typeof data === 'object' && Object.keys(data as object).length > 0) {
        incidents.push(data);
      }
    }

    return incidents;
  }

  /**
   * Warm Redis cache from Postgres results.
   */
  private async warmCache(rows: any[]): Promise<void> {
    if (!rows || rows.length === 0) return;

    const pipeline = this.redis.client.pipeline();

    for (const row of rows) {
      const key = `incident:${row.external_id}`;
      const stateKey = this.STATE_KEYS[row.status];

      // Write incident hash
      pipeline.hset(key, {
        external_id: row.external_id,
        component_id: row.component_id,
        service_type: row.service_type,
        severity: row.severity,
        status: row.status,
        first_signal_at: row.first_signal_at?.toISOString?.() || row.first_signal_at,
        updated_at: row.updated_at?.toISOString?.() || row.updated_at,
      });
      pipeline.expire(key, this.INCIDENT_TTL);

      // Add to state-specific sorted set (score = severity rank)
      if (stateKey) {
        const score = this.severityScore(row.severity);
        pipeline.zadd(stateKey, score, row.external_id);
      }
    }

    await pipeline.exec();
  }

  /**
   * Score for sorted set ordering: lower = higher priority.
   */
  private severityScore(severity: string): number {
    switch (severity) {
      case 'P0': return 0;
      case 'P1': return 1;
      case 'P2': return 2;
      case 'P3': return 3;
      default: return 4;
    }
  }

  /**
   * Aggregated dashboard statistics (unchanged — reads from Postgres).
   */
  async getStats() {
    const [statusCounts, severityCounts, mttrStats, recentClosed] = await Promise.all([
      this.pg.query(
        `SELECT status, COUNT(*) as count FROM work_items GROUP BY status`,
      ),
      this.pg.query(
        `SELECT severity, COUNT(*) as count FROM work_items GROUP BY severity`,
      ),
      this.pg.query(
        `SELECT
           severity,
           AVG(mttr_seconds) as avg_mttr,
           MIN(mttr_seconds) as min_mttr,
           MAX(mttr_seconds) as max_mttr,
           COUNT(*) as closed_count
         FROM work_items
         WHERE mttr_seconds IS NOT NULL
         GROUP BY severity`,
      ),
      this.pg.query(
        `SELECT external_id, component_id, severity, mttr_seconds, closed_at
         FROM work_items
         WHERE status = 'CLOSED'
         ORDER BY closed_at DESC
         LIMIT 10`,
      ),
    ]);

    return {
      by_status: statusCounts.rows,
      by_severity: severityCounts.rows,
      mttr: mttrStats.rows,
      recent_closed: recentClosed.rows,
    };
  }
}
