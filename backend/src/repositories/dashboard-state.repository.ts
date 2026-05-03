import { Injectable } from '@nestjs/common';
import { RedisService } from '@/common/redis/redis.service';

/**
 * DashboardStateRepository
 *
 * Cleanly encapsulates all Redis data-access operations for dashboard state.
 * Manages state-partitioned sorted sets and incident summary hashes.
 * No business logic lives here — only data access.
 *
 * Redis key structures:
 *   dashboard:{status}        — ZSET of external_ids (score = severity rank)
 *   incident:{external_id}    — HASH with summary fields (TTL-based)
 */
@Injectable()
export class DashboardStateRepository {
  private readonly STATE_KEYS: Record<string, string> = {
    OPEN: 'dashboard:open',
    INVESTIGATING: 'dashboard:investigating',
    RESOLVED: 'dashboard:resolved',
  };

  private readonly DEFAULT_TTL = 300; // 5 minutes

  constructor(private readonly redis: RedisService) {}

  // ─── State Set Operations ──────────────────────────────────────────

  /**
   * Get incident IDs from a state-specific sorted set.
   */
  async getIdsByStatus(status: string, start = 0, stop = 99): Promise<string[]> {
    const key = this.STATE_KEYS[status];
    if (!key) return [];
    return this.redis.client.zrange(key, start, stop);
  }

  /**
   * Get incident IDs from all active state sets.
   */
  async getAllActiveIds(limitPerState = 50): Promise<string[]> {
    const [openIds, investigatingIds, resolvedIds] = await Promise.all([
      this.redis.client.zrange(this.STATE_KEYS.OPEN, 0, limitPerState - 1),
      this.redis.client.zrange(this.STATE_KEYS.INVESTIGATING, 0, limitPerState - 1),
      this.redis.client.zrange(this.STATE_KEYS.RESOLVED, 0, limitPerState - 1),
    ]);

    return [...(openIds || []), ...(investigatingIds || []), ...(resolvedIds || [])];
  }

  /**
   * Add an incident to a state-specific sorted set.
   */
  async addToStateSet(status: string, externalId: string, score: number): Promise<void> {
    const key = this.STATE_KEYS[status];
    if (key) {
      await this.redis.client.zadd(key, score, externalId);
    }
  }

  /**
   * Remove an incident from a state-specific sorted set.
   */
  async removeFromStateSet(status: string, externalId: string): Promise<void> {
    const key = this.STATE_KEYS[status];
    if (key) {
      await this.redis.client.zrem(key, externalId);
    }
  }

  // ─── Incident Hash Operations ─────────────────────────────────────

  /**
   * Load incident summary hashes for multiple IDs (pipeline).
   */
  async loadIncidentSummaries(ids: string[]): Promise<any[]> {
    if (ids.length === 0) return [];

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
   * Set incident summary hash fields.
   */
  async setIncidentSummary(externalId: string, fields: Record<string, string>, ttl?: number): Promise<void> {
    const key = `incident:${externalId}`;
    const pipeline = this.redis.client.pipeline();
    pipeline.hset(key, fields);
    pipeline.expire(key, ttl || this.DEFAULT_TTL);
    await pipeline.exec();
  }

  /**
   * Update specific fields on an incident hash and refresh TTL.
   */
  async updateIncidentFields(externalId: string, fields: Record<string, string>, ttl?: number): Promise<void> {
    const key = `incident:${externalId}`;
    const pipeline = this.redis.client.pipeline();
    pipeline.hset(key, fields);
    pipeline.expire(key, ttl || this.DEFAULT_TTL);
    await pipeline.exec();
  }

  /**
   * Set a short expiry on an incident hash (e.g., for closed incidents).
   */
  async setIncidentExpiry(externalId: string, ttlSeconds: number): Promise<void> {
    await this.redis.client.expire(`incident:${externalId}`, ttlSeconds);
  }

  // ─── Batch / Warm Cache Operations ────────────────────────────────

  /**
   * Warm cache from a set of incident rows (pipeline).
   */
  async warmCache(rows: any[], ttl?: number): Promise<void> {
    if (!rows || rows.length === 0) return;

    const effectiveTtl = ttl || this.DEFAULT_TTL;
    const pipeline = this.redis.client.pipeline();

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
        updated_at: row.updated_at?.toISOString?.() || row.updated_at,
      });
      pipeline.expire(key, effectiveTtl);

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
    const pipeline = this.redis.client.pipeline();

    pipeline.zadd(this.STATE_KEYS.OPEN, this.severityScore(severity), externalId);
    pipeline.hset(`incident:${externalId}`, fields);
    pipeline.expire(`incident:${externalId}`, this.DEFAULT_TTL);

    await pipeline.exec();
  }

  /**
   * Move an incident between state sets and update its hash.
   */
  async moveIncidentState(
    externalId: string,
    oldStatus: string,
    newStatus: string,
    severity: string,
  ): Promise<void> {
    const pipeline = this.redis.client.pipeline();

    const oldKey = this.STATE_KEYS[oldStatus];
    if (oldKey) {
      pipeline.zrem(oldKey, externalId);
    }

    const newKey = this.STATE_KEYS[newStatus];
    if (newKey) {
      pipeline.zadd(newKey, this.severityScore(severity), externalId);
    }

    pipeline.hset(`incident:${externalId}`, {
      status: newStatus,
      updated_at: new Date().toISOString(),
    });
    pipeline.expire(`incident:${externalId}`, this.DEFAULT_TTL);

    if (newStatus === 'CLOSED') {
      pipeline.expire(`incident:${externalId}`, 60);
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

