import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '@/common/redis/redis.service';
import {
  ActiveAuditProcessingLeaseError,
  AuditDlqHandledError,
  AuditPersistenceProcessor,
} from './audit-persistence.processor';
import { MetricsService } from '@/common/services/metrics.service';
import { DebugLogger } from '@/common/utils/debug-logger';

/**
 * AuditStreamConsumer
 *
 * Independently consumes the audit persistence stream. Mongo audit persistence is
 * eventually consistent, so it can use its own backlog, retry policy, and DLQ
 * handling without blocking the main ingest/business pipeline.
 */
@Injectable()
export class AuditStreamConsumer implements OnModuleInit, OnModuleDestroy {
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
    private readonly processor: AuditPersistenceProcessor,
    private readonly metrics: MetricsService,
  ) {
    this.streamKey = process.env.AUDIT_STREAM_KEY || 'signals:audit';
    this.groupName = process.env.AUDIT_CONSUMER_GROUP || 'audit-workers';
    this.consumerName = `audit-worker-${process.pid}-${Date.now()}`;
    this.batchSize = parseInt(process.env.AUDIT_WORKER_BATCH_SIZE || '50', 10);
    this.blockMs = parseInt(process.env.AUDIT_WORKER_BLOCK_MS || '2000', 10);
    this.maxConcurrency = parseInt(process.env.AUDIT_WORKER_CONCURRENCY || '10', 10);
    this.claimIdleMs = parseInt(process.env.AUDIT_WORKER_CLAIM_IDLE_MS || '30000', 10);
  }

  async onModuleInit() {
    await this.ensureConsumerGroup();
    this.running = true;
    console.log(`[AuditWorker] Consumer "${this.consumerName}" starting on group "${this.groupName}"`);

    this.consumeLoop();
    this.pendingRecoveryLoop();
  }

  async onModuleDestroy() {
    this.running = false;
    console.log(`[AuditWorker] Consumer "${this.consumerName}" shutting down`);
  }

  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.auditStream.xgroup(
        'CREATE',
        this.streamKey,
        this.groupName,
        '0',
        'MKSTREAM',
      );
      console.log(`[AuditWorker] Created consumer group "${this.groupName}"`);
    } catch (err: any) {
      if (!err.message?.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        const results: any = await this.redis.auditStream.xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.streamKey,
          '>',
        );

        if (!results || results.length === 0) {
          continue;
        }

        const messages = results[0][1] as Array<[string, string[]]>;
        if (messages.length === 0) {
          continue;
        }

        DebugLogger.log('AuditWorker', 'Consumed audit stream batch', {
          consumer: this.consumerName,
          batchSize: messages.length,
        });

        await this.processBatch(messages);
      } catch (err) {
        console.error('[AuditWorker] Consume loop error:', err);
        await this.sleep(1000);
      }
    }
  }

  private async processBatch(messages: Array<[string, string[]]>): Promise<void> {
    for (let i = 0; i < messages.length; i += this.maxConcurrency) {
      const chunk = messages.slice(i, i + this.maxConcurrency);
      await Promise.allSettled(
        chunk.map(([messageId, fields]) => this.processOne(messageId, fields)),
      );
    }
  }

  private async processOne(messageId: string, fields: string[]): Promise<void> {
    try {
      const signal = this.parseFields(fields);
      await this.processor.process(signal);
      await this.redis.auditStream.xack(this.streamKey, this.groupName, messageId);
    } catch (err: any) {
      if (err instanceof AuditDlqHandledError) {
        await this.redis.auditStream.xack(this.streamKey, this.groupName, messageId);
        DebugLogger.log('AuditWorker', 'Acked audit message after DLQ handoff', {
          consumer: this.consumerName,
          messageId,
        });
        return;
      }

      if (err instanceof ActiveAuditProcessingLeaseError) {
        DebugLogger.log('AuditWorker', 'Skipping ACK because another worker holds the active audit lease', {
          consumer: this.consumerName,
          messageId,
        });
        return;
      }

      console.error(`[AuditWorker] Failed to persist audit message ${messageId}:`, err.message);
      this.metrics.incrementDbWriteFailures();
    }
  }

  private async pendingRecoveryLoop(): Promise<void> {
    while (this.running) {
      await this.sleep(15000);

      if (!this.running) break;

      try {
        const result: any = await this.redis.auditStream.xautoclaim(
          this.streamKey,
          this.groupName,
          this.consumerName,
          this.claimIdleMs,
          '0-0',
          'COUNT',
          this.batchSize,
        );

        if (result && result[1] && (result[1] as any[]).length > 0) {
          const claimed = result[1] as Array<[string, string[]]>;
          DebugLogger.log('AuditWorker', 'Reclaimed stale pending audit messages', {
            consumer: this.consumerName,
            claimedCount: claimed.length,
          });
          await this.processBatch(claimed);
        }
      } catch (err) {
        console.error('[AuditWorker] Pending recovery error:', err);
      }
    }
  }

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

