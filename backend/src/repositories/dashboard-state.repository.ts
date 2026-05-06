import { Injectable } from '@nestjs/common';
import { RedisService } from '@/common/redis/redis.service';

export interface DashboardIncidentCacheEntry {
  external_id: string;
  component_id: string;
  service_type: string;
  severity: string;
  status: string;
  first_signal_at: string;
  last_signal_at: string;
  signal_count: string;
  updated_at: string;
}

export interface LoadIncidentSummariesResult {
  incidents: DashboardIncidentCacheEntry[];
  missingIds: string[];
}

/**
 * DashboardStateRepository
 *
 * Cleanly encapsulates all Redis data-access operations for dashboard state.
 * Manages state-partitioned sorted sets and incident summary hashes.
 * No business logic lives here — only data access.
 *
 * Redis key structures:
 *   dashboard:{status}        — ZSET of external_ids (score = severity rank)
 *   incident:{external_id}    — HASH with live dashboard summary fields
 */
@Injectable()
export class DashboardStateRepository {
  private readonly STATE_KEYS: Record<string, string> = {
    OPEN: 'dashboard:open',
    INVESTIGATING: 'dashboard:investigating',
    RESOLVED: 'dashboard:resolved',
  };

  constructor(private readonly redis: RedisService) {}

  // ─── State Set Operations ──────────────────────────────────────────

  /**
   * Get incident IDs from a state-specific sorted set.
   */
  async getIdsByStatus(status: string, start = 0, stop = 99): Promise<string[]> {
    const key = this.STATE_KEYS[status];
    if (!key) return [];
    return this.redis.dashboard.zrange(key, start, stop);
  }

  /**
   * Get incident IDs from all active state sets.
   */
  async getAllActiveIds(limitPerState = 50): Promise<string[]> {
    const [openIds, investigatingIds, resolvedIds] = await Promise.all([
      this.redis.dashboard.zrange(this.STATE_KEYS.OPEN, 0, limitPerState - 1),
      this.redis.dashboard.zrange(this.STATE_KEYS.INVESTIGATING, 0, limitPerState - 1),
      this.redis.dashboard.zrange(this.STATE_KEYS.RESOLVED, 0, limitPerState - 1),
    ]);

    return [...new Set([...(openIds || []), ...(investigatingIds || []), ...(resolvedIds || [])])];
  }

  // ─── Incident Hash Operations ─────────────────────────────────────

  /**
   * Load incident summary hashes for multiple IDs (pipeline).
   */
  async loadIncidentSummaries(ids: string[]): Promise<LoadIncidentSummariesResult> {
    if (ids.length === 0) {
      return { incidents: [], missingIds: [] };
    }

    const pipeline = this.redis.dashboard.pipeline();
    for (const id of ids) {
      pipeline.hgetall(`incident:${id}`);
    }

    const results = await pipeline.exec();
    if (!results) {
      return { incidents: [], missingIds: [...ids] };
    }

    const incidents: DashboardIncidentCacheEntry[] = [];
    const missingIds: string[] = [];
    results.forEach(([err, data], index) => {
      if (!err && data && typeof data === 'object' && Object.keys(data as object).length > 0) {
        incidents.push(data as DashboardIncidentCacheEntry);
        return;
      }
      missingIds.push(ids[index]);
    });

    return { incidents, missingIds };
  }

  /**
   * Delete an incident summary hash.
   */
  async deleteIncidentSummary(externalId: string): Promise<void> {
    await this.redis.dashboard.del(`incident:${externalId}`);
  }

  /**
   * Remove incident IDs from all active dashboard state sets.
   */
  async removeFromAllStateSets(externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) {
      return;
    }

    const pipeline = this.redis.dashboard.pipeline();
    for (const key of Object.values(this.STATE_KEYS)) {
      pipeline.zrem(key, ...externalIds);
    }
    await pipeline.exec();
  }

  // ─── Batch / Warm Cache Operations ────────────────────────────────

  /**
   * Warm cache from a set of incident rows (pipeline).
   */
  async warmCache(rows: any[]): Promise<void> {
    if (!rows || rows.length === 0) return;

    const pipeline = this.redis.dashboard.pipeline();

    for (const row of rows) {
      const key = `incident:${row.external_id}`;
      const stateKey = this.STATE_KEYS[row.status];

      pipeline.hset(key, {
        external_id: row.external_id,
        component_id: row.component_id,
        service_type: row.service_type,
        severity: row.severity,
        status: row.status,
        first_signal_at: row.first_signal_at?.toISOString?.() || row.first_signal_at,
        last_signal_at: row.last_signal_at?.toISOString?.() || row.last_signal_at,
        signal_count: String(row.signal_count ?? 0),
        updated_at: row.updated_at?.toISOString?.() || row.updated_at,
      });

      if (stateKey) {
        const score = this.severityScore(row.severity);
        pipeline.zadd(stateKey, score, row.external_id);
      }
    }

    await pipeline.exec();
  }

  // ─── Composite Pipeline Operations ────────────────────────────────

  /**
   * Handle a full incident creation cache update (add to set + write hash).
   */
  async addNewIncident(
    externalId: string,
    fields: Record<string, string>,
    severity: string,
  ): Promise<void> {
    const pipeline = this.redis.dashboard.multi();

    pipeline.zadd(this.STATE_KEYS.OPEN, this.severityScore(severity), externalId);
    pipeline.hset(`incident:${externalId}`, fields);

    await pipeline.exec();
  }

  /**
   * Upsert an active incident projection in Redis.
   */
  async upsertActiveIncidentProjection(
    status: string,
    externalId: string,
    fields: Record<string, string>,
    severity: string,
  ): Promise<void> {
    const key = this.STATE_KEYS[status];
    if (!key) {
      return;
    }

    const pipeline = this.redis.dashboard.multi();
    pipeline.zadd(key, this.severityScore(severity), externalId);
    pipeline.hset(`incident:${externalId}`, fields);
    await pipeline.exec();
  }

  /**
   * Move an incident between state sets and update its hash.
   */
  async moveIncidentState(
    externalId: string,
    oldStatus: string,
    newStatus: string,
    fields: Record<string, string> | null,
    severity?: string,
  ): Promise<void> {
    const pipeline = this.redis.dashboard.multi();

    const oldKey = this.STATE_KEYS[oldStatus];
    if (oldKey) {
      pipeline.zrem(oldKey, externalId);
    }

    if (newStatus === 'CLOSED') {
      pipeline.del(`incident:${externalId}`);
      await pipeline.exec();
      return;
    }

    const newKey = this.STATE_KEYS[newStatus];
    if (newKey && severity) {
      pipeline.zadd(newKey, this.severityScore(severity), externalId);
    }

    if (fields) {
      pipeline.hset(`incident:${externalId}`, fields);
    }

    await pipeline.exec();
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private severityScore(severity: string): number {
    switch (severity) {
      case 'P0': return 0;
      case 'P1': return 1;
      case 'P2': return 2;
      case 'P3': return 3;
      default: return 4;
    }
  }
}

