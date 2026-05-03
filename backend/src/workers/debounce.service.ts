import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { v4 as uuidv4 } from 'uuid';

interface DebounceResult {
  workItemExternalId: string;
  isNew: boolean;
}

/**
 * DebounceService
 *
 * Ensures that many signals for the same component_id within a 10-second
 * window produce only ONE work item, while all signals link to it.
 *
 * Algorithm: Redis SET NX + distributed lock + double-check
 *
 * Flow:
 *   1. GET debounce:{component_id}
 *   2. If exists → return existing work_item_external_id (not new)
 *   3. If absent → acquire lock, double-check, create new UUID, SET with TTL
 *
 * Why lock + double-check:
 *   Without lock, two workers can both see "absent" and both create work items.
 *   Lock serializes the creation path for a given component.
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

  constructor(private readonly redis: RedisService) {
    this.debounceTtl = parseInt(process.env.DEBOUNCE_TTL_SEC || '10', 10);
    this.lockTtl = 2;
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
    serviceType: string,
    severity: string,
    eventTs: Date,
  ): Promise<DebounceResult> {
    const debounceKey = `debounce:${componentId}`;

    // ─── Fast path: debounce key exists → reuse ────────────────────
    const existing = await this.redis.client.get(debounceKey);
    if (existing) {
      return { workItemExternalId: existing, isNew: false };
    }

    // ─── Slow path: acquire lock, double-check, create ─────────────
    const lockKey = `lock:debounce:${componentId}`;
    const lockValue = `${process.pid}-${Date.now()}`;

    const acquired = await this.acquireLock(lockKey, lockValue);
    if (!acquired) {
      // Could not get lock — someone else is creating. Re-read debounce key.
      const retryExisting = await this.redis.client.get(debounceKey);
      if (retryExisting) {
        return { workItemExternalId: retryExisting, isNew: false };
      }
      // Still nothing — very rare. Generate new ID anyway (slight over-creation risk).
      console.warn(`[Debounce] Lock timeout for ${componentId}, creating anyway`);
    }

    try {
      // ─── Double-check after lock ──────────────────────────────────
      const doubleCheck = await this.redis.client.get(debounceKey);
      if (doubleCheck) {
        return { workItemExternalId: doubleCheck, isNew: false };
      }

      // ─── Create new work item ID and set debounce key ─────────────
      const newExternalId = uuidv4();

      // SET debounce key with TTL = 10 seconds
      await this.redis.client.set(debounceKey, newExternalId, 'EX', this.debounceTtl);

      return { workItemExternalId: newExternalId, isNew: true };
    } finally {
      // Release lock (only if we still own it)
      await this.releaseLock(lockKey, lockValue);
    }
  }

  /**
   * Acquire a simple distributed lock via SET NX EX.
   * Retries with backoff up to maxRetries.
   */
  private async acquireLock(key: string, value: string): Promise<boolean> {
    for (let i = 0; i < this.lockMaxRetries; i++) {
      const result = await this.redis.client.set(key, value, 'EX', this.lockTtl, 'NX');
      if (result === 'OK') {
        return true;
      }
      // Wait before retry
      await new Promise((r) => setTimeout(r, this.lockRetryMs));
    }
    return false;
  }

  /**
   * Release lock only if we still own it (Lua atomic check-and-delete).
   */
  private async releaseLock(key: string, value: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      await this.redis.client.eval(script, 1, key, value);
    } catch {
      // Lock may have expired — non-critical
    }
  }
}

