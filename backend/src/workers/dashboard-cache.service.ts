import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

/**
 * DashboardCacheService
 *
 * Manages the Redis hot-path cache for the live dashboard.
 * State-partitioned: separate sorted sets per workflow status.
 *
 * Cache structures:
 *   dashboard:open            — ZSET of external_ids in OPEN state
 *   dashboard:investigating   — ZSET of external_ids in INVESTIGATING state
 *   dashboard:resolved        — ZSET of external_ids in RESOLVED state
 *   incident:{externalId}     — HASH with summary fields (TTL 5 min)
 */
@Injectable()
export class DashboardCacheService {
  private readonly STATE_KEYS: Record<string, string> = {
    OPEN: 'dashboard:open',
    INVESTIGATING: 'dashboard:investigating',
    RESOLVED: 'dashboard:resolved',
  };

  private readonly INCIDENT_TTL = 300; // 5 minutes

  constructor(private readonly redis: RedisService) {}

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
      const pipeline = this.redis.client.pipeline();

      // Add to OPEN sorted set
      pipeline.zadd(this.STATE_KEYS.OPEN, this.severityScore(severity), externalId);

      // Write incident summary hash
      pipeline.hset(`incident:${externalId}`, {
        external_id: externalId,
        component_id: componentId,
        service_type: serviceType,
        severity,
        status: 'OPEN',
        first_signal_at: firstSignalAt,
        updated_at: new Date().toISOString(),
      });
      pipeline.expire(`incident:${externalId}`, this.INCIDENT_TTL);

      await pipeline.exec();
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
        // Already handled by onIncidentCreated in worker
        return;
      }

      // Refresh hash fields
      const pipeline = this.redis.client.pipeline();
      pipeline.hset(`incident:${externalId}`, {
        updated_at: new Date().toISOString(),
      });
      pipeline.expire(`incident:${externalId}`, this.INCIDENT_TTL);
      await pipeline.exec();
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
      const pipeline = this.redis.client.pipeline();

      // Remove from old state set
      const oldKey = this.STATE_KEYS[oldStatus];
      if (oldKey) {
        pipeline.zrem(oldKey, externalId);
      }

      // Add to new state set (unless CLOSED)
      const newKey = this.STATE_KEYS[newStatus];
      if (newKey) {
        pipeline.zadd(newKey, this.severityScore(severity), externalId);
      }

      // Update incident hash
      pipeline.hset(`incident:${externalId}`, {
        status: newStatus,
        updated_at: new Date().toISOString(),
      });
      pipeline.expire(`incident:${externalId}`, this.INCIDENT_TTL);

      // If closed, clean up hash after short delay
      if (newStatus === 'CLOSED') {
        pipeline.expire(`incident:${externalId}`, 60); // keep 60s then expire
      }

      await pipeline.exec();
    } catch (err) {
      console.error('[DashboardCache] onStatusChanged failed:', err);
    }
  }

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
