import { Injectable } from '@nestjs/common';
import { RedisService } from '@/common/redis/redis.service';
import { AuditPersistenceRepository } from '@/repositories';

export interface AuditDispatchPayload {
  signal_id: string;
  component_id: string;
  service_type: string;
  severity: string;
  event_ts: string;
  payload: Record<string, any>;
  trace_id?: string;
  received_at: string;
  work_item_external_id: string;
}

/**
 * AuditDispatchService
 *
 * Schedules raw-signal persistence on a separate async pipeline:
 *   1. record / refresh a small Postgres audit ledger row
 *   2. publish a message to the dedicated audit Redis stream when needed
 *
 * This keeps Mongo audit persistence out of the main business critical path while
 * still preserving independent retry and failure tracking for the audit flow.
 */
@Injectable()
export class AuditDispatchService {
  private readonly streamKey: string;
  private readonly maxLength: number;

  constructor(
    private readonly auditLedger: AuditPersistenceRepository,
    private readonly redis: RedisService,
  ) {
    this.streamKey = process.env.AUDIT_STREAM_KEY || 'signals:audit';
    this.maxLength = parseInt(process.env.AUDIT_STREAM_MAX_LENGTH || '100000', 10);
  }

  async schedule(payload: AuditDispatchPayload): Promise<void> {
    const scheduled = await this.auditLedger.schedule(
      payload.signal_id,
      payload.work_item_external_id,
    );

    if (
      scheduled.disposition === 'ALREADY_SCHEDULED'
      || scheduled.disposition === 'ALREADY_PERSISTED'
      || scheduled.disposition === 'ALREADY_DEAD_LETTERED'
    ) {
      return;
    }

    await this.redis.queue.xadd(
      this.streamKey,
      'MAXLEN',
      '~',
      String(this.maxLength),
      '*',
      'signal_id', payload.signal_id,
      'component_id', payload.component_id,
      'service_type', payload.service_type,
      'severity', payload.severity,
      'event_ts', payload.event_ts,
      'payload', JSON.stringify(payload.payload ?? {}),
      'trace_id', payload.trace_id || '',
      'received_at', payload.received_at,
      'work_item_external_id', payload.work_item_external_id,
    );
  }
}

