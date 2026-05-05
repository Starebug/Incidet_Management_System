import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { WorkItemService } from './work-item.service';
import { v4 as uuidv4 } from 'uuid';

export interface DebounceResult {
  workItemExternalId: string;
  isNew: boolean;
  creationToken?: string;
}

interface AtomicDebounceAcquireResult {
  disposition: 'EXISTING' | 'ACQUIRED' | 'WAIT';
  existingId?: string;
}

export class DebounceResolutionInProgressError extends Error {
  constructor(componentId: string) {
    super(`Debounce resolution is still in progress for component ${componentId}`);
    this.name = 'DebounceResolutionInProgressError';
  }
}

/**
 * DebounceService
 *
 * Ensures that many signals for the same component_id within a 10-second
 * window produce only ONE work item, while all signals link to it.
 *
 * Algorithm: Redis Lua atomic get-or-acquire + explicit publish on create success
 *
 * Flow:
 *   1. Atomically check debounce:{component_id}
 *   2. If exists → return existing work_item_external_id (not new)
 *   3. If absent and no creator lock exists → acquire creator lock
 *   4. Winner creates the work item, then publishes debounce key on success
 *   5. Losers wait/retry; they never "create anyway"
 *
 * Why explicit publish after Postgres create:
 *   Publishing debounce:{component_id} before the work item exists would let other
 *   workers treat a not-yet-created incident as reusable. So the creator lock stays
 *   held until the winning worker successfully creates the work item and publishes
 *   the debounce key.
 *
 * Lock implementation: Redis SET NX EX (simple distributed lock)
 *   - Key:  lock:debounce:{component_id}
 *   - TTL:  2 seconds (short — only guards the create path)
 *   - Safe: if lock holder crashes, TTL auto-releases
 */
@Injectable()
export class DebounceService {
  private readonly debounceTtl: number; // seconds
  private readonly lockTtl: number;     // seconds
  private readonly lockRetryMs: number;
  private readonly lockMaxRetries: number;
  private readonly GET_OR_ACQUIRE_SCRIPT = `
    local debounce_key = KEYS[1]
    local lock_key = KEYS[2]
    local lock_value = ARGV[1]
    local lock_ttl = tonumber(ARGV[2])

    local existing = redis.call('get', debounce_key)
    if existing then
      return {'EXISTING', existing}
    end

    local acquired = redis.call('set', lock_key, lock_value, 'EX', lock_ttl, 'NX')
    if acquired then
      return {'ACQUIRED'}
    end

    return {'WAIT'}
  `;

  private readonly PUBLISH_NEW_WORK_ITEM_SCRIPT = `
    local debounce_key = KEYS[1]
    local lock_key = KEYS[2]
    local work_item_id = ARGV[1]
    local lock_value = ARGV[2]
    local debounce_ttl = tonumber(ARGV[3])

    if redis.call('get', lock_key) == lock_value then
      redis.call('set', debounce_key, work_item_id, 'EX', debounce_ttl)
      redis.call('del', lock_key)
      return work_item_id
    end

    redis.call('set', debounce_key, work_item_id, 'EX', debounce_ttl, 'NX')
    local existing = redis.call('get', debounce_key)
    return existing or ''
  `;

  private readonly RELEASE_LOCK_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(
    private readonly redis: RedisService,
    private readonly workItem: WorkItemService,
  ) {
    this.debounceTtl = parseInt(process.env.DEBOUNCE_TTL_SEC || '10', 10);
    this.lockTtl = parseInt(process.env.DEBOUNCE_CREATION_LOCK_TTL_SEC || '10', 10);
    this.lockRetryMs = 50;
    this.lockMaxRetries = 20; // 20 × 50ms = 1s max wait
  }

  /**
   * Resolve whether to create a new work item or reuse an existing one.
   *
   * @param componentId - e.g. "CACHE_CLUSTER_01"
   * @param serviceType - e.g. "DISTRIBUTED_CACHE"
   * @param severity    - resolved severity (P0/P1/P2/P3)
   * @param eventTs     - timestamp of the signal event
   * @returns workItemExternalId + isNew flag
   */
  async resolveWorkItem(
    componentId: string,
    _serviceType: string,
    _severity: string,
    _eventTs: Date,
  ): Promise<DebounceResult> {
    const debounceKey = `debounce:${componentId}`;
    const lockKey = `lock:debounce:${componentId}`;
    const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    for (let i = 0; i < this.lockMaxRetries; i++) {
      const result = await this.atomicGetOrAcquire(debounceKey, lockKey, lockValue);

      if (result.disposition === 'EXISTING' && result.existingId) {
        return { workItemExternalId: result.existingId, isNew: false };
      }

      if (result.disposition === 'ACQUIRED') {
        try {
          const activeExisting = await this.findAndCacheActiveWorkItem(componentId, debounceKey);
          if (activeExisting) {
            await this.releaseLock(lockKey, lockValue);
            return { workItemExternalId: activeExisting, isNew: false };
          }

          return {
            workItemExternalId: uuidv4(),
            isNew: true,
            creationToken: lockValue,
          };
        } catch (err) {
          await this.releaseLock(lockKey, lockValue);
          throw err;
        }
      }

      const activeExisting = await this.findAndCacheActiveWorkItem(componentId, debounceKey);
      if (activeExisting) {
        return { workItemExternalId: activeExisting, isNew: false };
      }

      await this.sleep(this.lockRetryMs);
    }

    throw new DebounceResolutionInProgressError(componentId);
  }

  /**
   * Publish the winning work item id only after the Postgres create succeeds.
   * Also releases the creator lock if this worker still owns it.
   */
  async finalizeNewWorkItem(
    componentId: string,
    workItemExternalId: string,
    creationToken: string,
  ): Promise<void> {
    const debounceKey = `debounce:${componentId}`;
    const lockKey = `lock:debounce:${componentId}`;

    await this.redis.client.eval(
      this.PUBLISH_NEW_WORK_ITEM_SCRIPT,
      2,
      debounceKey,
      lockKey,
      workItemExternalId,
      creationToken,
      String(this.debounceTtl),
    );
  }

  /**
   * Release a pending creator lock without publishing a debounce result.
   * Used when the winner fails before the work item is successfully created.
   */
  async abandonPendingWorkItem(componentId: string, creationToken: string): Promise<void> {
    const lockKey = `lock:debounce:${componentId}`;
    await this.releaseLock(lockKey, creationToken);
  }

  /**
   * Release lock only if we still own it (Lua atomic check-and-delete).
   */
  private async releaseLock(key: string, value: string): Promise<void> {
    try {
      await this.redis.client.eval(this.RELEASE_LOCK_SCRIPT, 1, key, value);
    } catch {
      // Lock may have expired — non-critical
    }
  }

  private async atomicGetOrAcquire(
    debounceKey: string,
    lockKey: string,
    lockValue: string,
  ): Promise<AtomicDebounceAcquireResult> {
    const raw = await this.redis.client.eval(
      this.GET_OR_ACQUIRE_SCRIPT,
      2,
      debounceKey,
      lockKey,
      lockValue,
      String(this.lockTtl),
    ) as [string, string?] | string[];

    const [disposition, existingId] = raw;
    return {
      disposition: disposition as AtomicDebounceAcquireResult['disposition'],
      existingId,
    };
  }

  /**
   * Reuse an already active incident after the debounce TTL expires.
   * This reduces fragmentation of long-running outages into multiple work items.
   */
  private async findAndCacheActiveWorkItem(
    componentId: string,
    debounceKey: string,
  ): Promise<string | null> {
    const active = await this.workItem.findActiveByComponent(componentId);
    if (!active?.external_id) {
      return null;
    }

    await this.redis.client.set(debounceKey, active.external_id, 'EX', this.debounceTtl);
    return active.external_id;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

