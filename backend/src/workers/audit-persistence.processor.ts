import { Injectable } from '@nestjs/common';
import { AuditPersistenceRepository, SignalRepository } from '@/repositories';
import { DlqService } from './dlq.service';
import { DebugLogger } from '@/common/utils/debug-logger';

export class ActiveAuditProcessingLeaseError extends Error {
  constructor(signalId: string) {
    super(`Audit persistence for signal ${signalId} is already being processed by another worker`);
    this.name = 'ActiveAuditProcessingLeaseError';
  }
}

export class AuditDlqHandledError extends Error {
  constructor(signalId: string) {
    super(`Audit persistence for signal ${signalId} was handed off to the dead letter queue`);
    this.name = 'AuditDlqHandledError';
  }
}

/**
 * AuditPersistenceProcessor
 *
 * Persists raw signals to MongoDB on a separate async pipeline. Its retry model,
 * lease handling, and failure accounting are intentionally independent from the
 * main ingest/business-processing ledger.
 */
@Injectable()
export class AuditPersistenceProcessor {
  private readonly maxAttempts: number;

  constructor(
    private readonly auditLedger: AuditPersistenceRepository,
    private readonly signalRepo: SignalRepository,
    private readonly dlq: DlqService,
  ) {
    this.maxAttempts = parseInt(process.env.AUDIT_MAX_ATTEMPTS || '5', 10);
  }

  async process(signal: Record<string, string>): Promise<void> {
    const startedAt = Date.now();
    const {
      signal_id,
      component_id,
      service_type,
      severity,
      event_ts,
      payload: payloadStr,
      trace_id,
      received_at,
      work_item_external_id,
    } = signal;

    const processing = await this.auditLedger.beginProcessing(signal_id);
    if (processing.disposition === 'ALREADY_PERSISTED' || processing.disposition === 'ALREADY_DEAD_LETTERED') {
      return;
    }

    if (processing.disposition === 'LEASE_HELD') {
      DebugLogger.log('AuditPersistence', `Signal ${signal_id} is already under an active audit-processing lease`, {
        attemptCount: processing.attemptCount,
        leaseAgeMs: processing.leaseAgeMs,
      });
      throw new ActiveAuditProcessingLeaseError(signal_id);
    }

    if (processing.attemptCount > this.maxAttempts) {
      await this.handoffToDlq(
        signal,
        processing.attemptCount,
        `Exceeded max audit persistence attempts (${this.maxAttempts})`,
      );
      throw new AuditDlqHandledError(signal_id);
    }

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(payloadStr || '{}');
    } catch {
      payload = {};
    }

    try {
      await this.signalRepo.upsertRawSignal({
        signal_id,
        component_id,
        service_type,
        severity,
        event_ts: new Date(event_ts),
        received_at: new Date(received_at),
        payload,
        trace_id: trace_id || undefined,
        linked_work_item_id: work_item_external_id || processing.workItemExternalId || null,
      });

      await this.auditLedger.markPersisted(signal_id);
      DebugLogger.log('AuditPersistence', `Persisted raw audit signal ${signal_id}`, {
        workItemExternalId: work_item_external_id || processing.workItemExternalId,
        attemptCount: processing.attemptCount,
        durationMs: Date.now() - startedAt,
      });
    } catch (err: any) {
      if (err instanceof AuditDlqHandledError) {
        throw err;
      }

      await this.auditLedger.markFailed(signal_id, err?.message || 'Unknown audit persistence error');
      throw err;
    }
  }

  private async handoffToDlq(
    signal: Record<string, string>,
    attemptCount: number,
    reason: string,
  ): Promise<void> {
    const persisted = await this.dlq.send(
      signal,
      'AUDIT_PERSISTENCE_MAX_ATTEMPTS_EXCEEDED',
      reason,
      attemptCount,
    );

    if (!persisted) {
      throw new Error(`Audit DLQ handoff failed for signal ${signal.signal_id}`);
    }

    await this.auditLedger.markDeadLettered(signal.signal_id, reason);
    DebugLogger.log('AuditPersistence', `Signal ${signal.signal_id} moved to audit DLQ`, {
      attemptCount,
      reason,
    });
  }
}

