import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '@/common/redis/redis.service';
import { SignalProcessor, ActiveProcessingLeaseError, DlqHandledError } from './signal.processor';
import { DebounceResolutionInProgressError } from './debounce.service';
import { MetricsService } from '@/common/services/metrics.service';
import { DebugLogger } from '@/common/utils/debug-logger';

/**
 * SignalStreamConsumer
 *
 * Consumes signals from Redis Streams using consumer groups.
 * Provides: at-least-once delivery, parallel consumption, pending recovery.
 *
 * Flow:
 *   1. XREADGROUP — read batch of new messages
 *   2. Process each via SignalProcessor
 *   3. XACK on success
 *   4. On failure — leave unACKed (auto-redelivery from PEL)
 *   5. Periodically XAUTOCLAIM stale pending messages
 */
@Injectable()
export class SignalStreamConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private readonly streamKey: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly maxConcurrency: number;
  private readonly claimIdleMs: number;

  constructor(
    private readonly redis: RedisService,
    private readonly processor: SignalProcessor,
    private readonly metrics: MetricsService,
  ) {
    this.streamKey = process.env.STREAM_KEY || 'signals:ingest';
    this.groupName = process.env.CONSUMER_GROUP || 'signal-workers';
    this.consumerName = `worker-${process.pid}-${Date.now()}`;
    this.batchSize = parseInt(process.env.WORKER_BATCH_SIZE || '50', 10);
    this.blockMs = parseInt(process.env.WORKER_BLOCK_MS || '2000', 10);
    this.maxConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '10', 10);
    this.claimIdleMs = parseInt(process.env.WORKER_CLAIM_IDLE_MS || '30000', 10);
  }

  async onModuleInit() {
    await this.ensureConsumerGroup();
    this.running = true;
    console.log(`[Worker] Consumer "${this.consumerName}" starting on group "${this.groupName}"`);

    // Start main consume loop (non-blocking)
    this.consumeLoop();

    // Start periodic pending recovery
    this.pendingRecoveryLoop();
  }

  async onModuleDestroy() {
    this.running = false;
    console.log(`[Worker] Consumer "${this.consumerName}" shutting down`);
  }

  /**
   * Create consumer group if it doesn't exist.
   * MKSTREAM creates the stream if it doesn't exist either.
   */
  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.stream.xgroup(
        'CREATE',
        this.streamKey,
        this.groupName,
        '0',
        'MKSTREAM',
      );
      console.log(`[Worker] Created consumer group "${this.groupName}"`);
    } catch (err: any) {
      // BUSYGROUP = group already exists — that's fine
      if (!err.message?.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  /**
   * Main consume loop.
   * Reads batches from Redis Stream and processes them with bounded concurrency.
   */
  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        const results: any = await this.redis.stream.xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.streamKey,
          '>',  // Only new messages not yet delivered to this group
        );

        if (!results || results.length === 0) {
          continue; // Timeout, no new messages
        }

        // results = [[streamKey, [[messageId, fields], ...]]]
        const messages = results[0][1] as Array<[string, string[]]>;

        if (messages.length === 0) {
          continue;
        }

        DebugLogger.log('SignalWorker', 'Consumed stream batch', {
          consumer: this.consumerName,
          batchSize: messages.length,
        });

        // Process with bounded concurrency
        await this.processBatch(messages);

      } catch (err) {
        console.error('[Worker] Consume loop error:', err);
        // Back off on error to avoid tight error loop
        await this.sleep(1000);
      }
    }
  }

  /**
   * Process a batch of messages with bounded concurrency.
   * Uses a simple semaphore approach.
   */
  private async processBatch(messages: Array<[string, string[]]>): Promise<void> {
    // Chunk messages into concurrency-limited groups
    for (let i = 0; i < messages.length; i += this.maxConcurrency) {
      const chunk = messages.slice(i, i + this.maxConcurrency);

      const promises = chunk.map(([messageId, fields]) =>
        this.processOne(messageId, fields),
      );

      await Promise.allSettled(promises);
    }
  }

  /**
   * Process a single stream message.
   * ACK only on success; leave unACKed for redelivery on failure.
   */
  private async processOne(messageId: string, fields: string[]): Promise<void> {
    try {
      // Convert flat field array to object: [k1, v1, k2, v2] → {k1: v1, k2: v2}
      const signal = this.parseFields(fields);

      await this.processor.process(signal);

      // ACK — message is fully processed
      await this.redis.stream.xack(this.streamKey, this.groupName, messageId);

      this.metrics.incrementSignalsProcessed();
      DebugLogger.log('SignalWorker', 'Acked message', {
        consumer: this.consumerName,
        messageId,
      });
    } catch (err: any) {
      if (err instanceof DlqHandledError) {
        await this.redis.stream.xack(this.streamKey, this.groupName, messageId);
        DebugLogger.log('SignalWorker', 'Acked message after DLQ handoff', {
          consumer: this.consumerName,
          messageId,
        });
        return;
      }

      if (err instanceof ActiveProcessingLeaseError) {
        DebugLogger.log('SignalWorker', 'Skipping ACK because another worker holds the active processing lease', {
          consumer: this.consumerName,
          messageId,
        });
        return;
      }

      if (err instanceof DebounceResolutionInProgressError) {
        DebugLogger.log('SignalWorker', 'Skipping ACK because debounce resolution is still in progress', {
          consumer: this.consumerName,
          messageId,
        });
        return;
      }

      console.error(`[Worker] Failed to process message ${messageId}:`, err.message);
      // Do NOT ack — message stays in PEL for redelivery or claim
      this.metrics.incrementDbWriteFailures();
    }
  }

  /**
   * Periodically reclaim messages stuck in pending (from crashed consumers).
   * Runs every 15 seconds.
   */
  private async pendingRecoveryLoop(): Promise<void> {
    while (this.running) {
      await this.sleep(15000);

      if (!this.running) break;

      try {
        // XAUTOCLAIM: claim messages idle > claimIdleMs from any consumer
        const result: any = await this.redis.stream.xautoclaim(
          this.streamKey,
          this.groupName,
          this.consumerName,
          this.claimIdleMs,
          '0-0',
          'COUNT',
          this.batchSize,
        );

        // result = [nextStartId, [[messageId, fields], ...], deletedIds]
        if (result && result[1] && (result[1] as any[]).length > 0) {
          const claimed = result[1] as Array<[string, string[]]>;
          DebugLogger.log('SignalWorker', 'Reclaimed stale pending messages', {
            consumer: this.consumerName,
            claimedCount: claimed.length,
          });
          await this.processBatch(claimed);
        }
      } catch (err) {
        // XAUTOCLAIM may fail if stream/group doesn't exist yet — non-critical
        console.error('[Worker] Pending recovery error:', err);
      }
    }
  }

  /**
   * Parse Redis Stream flat fields array into a keyed object.
   * Input:  ['signal_id', 'abc', 'component_id', 'CACHE_01', ...]
   * Output: { signal_id: 'abc', component_id: 'CACHE_01', ... }
   */
  private parseFields(fields: string[]): Record<string, string> {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return obj;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}



