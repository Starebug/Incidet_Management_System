import { Injectable } from '@nestjs/common';
import { IngestLedgerRepository } from '@/repositories';
import { DebounceResolutionInProgressError, DebounceService } from './debounce.service';
import { WorkItemService } from './work-item.service';
import { AlertStrategyResolver } from './alerting/alert-strategy.resolver';
import { DashboardCacheService } from './dashboard-cache.service';
import { DlqService } from './dlq.service';
import { AuditDispatchService } from './audit-dispatch.service';
import { DebugLogger } from '@/common/utils/debug-logger';

export class ActiveProcessingLeaseError extends Error {
  constructor(signalId: string) {
    super(`Signal ${signalId} is already being processed by another worker`);
    this.name = 'ActiveProcessingLeaseError';
  }
}

export class DlqHandledError extends Error {
  constructor(signalId: string) {
    super(`Signal ${signalId} was handed off to the dead letter queue`);
    this.name = 'DlqHandledError';
  }
}

/**
 * SignalProcessor
 *
 * Orchestrates the full processing pipeline for one signal:
 *
 *   1. Determine alert severity (Strategy Pattern)
 *   2. Resolve debounce (reuse or create work item)
 *   3. Create/update Postgres work item
  *   4. Schedule async audit persistence on a separate queue + ledger
  *   5. Refresh the live dashboard projection for incident creates/updates
 *
 * Never calls a DB driver directly — all data access via repositories.
 * Idempotency: ingest ledger status = PROCESSED means already completed end-to-end.
 * Mongo audit persistence is now a separate eventually-consistent pipeline with
 * its own retry and failure tracking; it is NOT part of the main ingest ledger.
 */
@Injectable()
export class SignalProcessor {
  private readonly maxAttempts: number;

  constructor(
    private readonly ingestLedger: IngestLedgerRepository,
    private readonly debounce: DebounceService,
    private readonly workItem: WorkItemService,
    private readonly alertResolver: AlertStrategyResolver,
    private readonly dashboardCache: DashboardCacheService,
    private readonly dlq: DlqService,
    private readonly auditDispatch: AuditDispatchService,
  ) {
    this.maxAttempts = parseInt(process.env.INGEST_MAX_ATTEMPTS || '5', 10);
  }

  /**
   * Process a single signal end-to-end.
   * @param signal - Parsed fields from Redis Stream message
   */
  async process(signal: Record<string, string>): Promise<void> {
    const startedAt = Date.now();
    const {
      signal_id,
      component_id,
      service_type,
      severity: rawSeverity,
      event_ts,
      payload: payloadStr,
      trace_id,
      received_at,
    } = signal;

    const processing = await this.ingestLedger.beginProcessing(signal_id);
    if (processing.disposition === 'ALREADY_PROCESSED') {
      DebugLogger.log('SignalProcessor', `Signal ${signal_id} already fully processed, skipping`);
      return;
    }

    if (processing.disposition === 'LEASE_HELD') {
      DebugLogger.log('SignalProcessor', `Signal ${signal_id} is already under an active processing lease`, {
        attemptCount: processing.attemptCount,
        leaseAgeMs: processing.leaseAgeMs,
      });
      throw new ActiveProcessingLeaseError(signal_id);
    }

    if (processing.attemptCount > this.maxAttempts) {
      await this.handoffToDlq(
        signal,
        processing.attemptCount,
        `Exceeded max processing attempts (${this.maxAttempts})`,
      );
      throw new DlqHandledError(signal_id);
    }

    // Parse payload from JSON string
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(payloadStr || '{}');
    } catch {
      payload = {};
    }

    let creationToken: string | undefined;
    let newWorkItemPublished = false;

    try {
      // ─── Step 1: Determine alert severity via Strategy Pattern ─────
      const alertStrategy = this.alertResolver.resolve(service_type);
      const severity = alertStrategy.determineSeverity({
        service_type,
        component_id,
        payload,
        rawSeverity,
      });

      // ─── Step 2: Resolve debounce (get or create work item) ────────
      const resolution = await this.debounce.resolveWorkItem(
        component_id,
        service_type,
        severity,
        new Date(event_ts),
      );
      const { workItemExternalId, isNew } = resolution;
      creationToken = resolution.creationToken;

      // ─── Step 3: Update work item in Postgres ──────────────────────
      if (isNew) {
        // Create new work item + initial status history
        await this.workItem.create({
          externalId: workItemExternalId,
          componentId: component_id,
          serviceType: service_type,
          severity,
          firstSignalAt: new Date(event_ts),
          lastSignalAt: new Date(event_ts),
        });

        if (creationToken) {
          await this.debounce.finalizeNewWorkItem(component_id, workItemExternalId, creationToken);
          newWorkItemPublished = true;
        }

        await this.dashboardCache.onIncidentCreated(
          workItemExternalId,
          component_id,
          service_type,
          severity,
          new Date(event_ts).toISOString(),
        );
      } else {
        // Update existing: increment signal_count, update last_signal_at
        await this.workItem.addSignal(workItemExternalId, new Date(event_ts));
        await this.dashboardCache.onIncidentUpdated(workItemExternalId);
      }

      // ─── Step 4: Schedule raw-signal audit persistence asynchronously ───
      await this.auditDispatch.schedule({
        signal_id,
        component_id,
        service_type,
        severity: rawSeverity,
        event_ts,
        payload,
        trace_id,
        received_at,
        work_item_external_id: workItemExternalId,
      });

      // Mark business completion only after every business-side effect succeeds
      // and the audit persistence task has been durably scheduled.
      await this.ingestLedger.markProcessed(signal_id);

      DebugLogger.log('SignalProcessor', `Processed signal ${signal_id}`, {
        component_id,
        service_type,
        severity,
        workItemExternalId,
        isNew,
        attemptCount: processing.attemptCount,
        durationMs: Date.now() - startedAt,
      });
    } catch (err: any) {
      if (err instanceof DlqHandledError || err instanceof DebounceResolutionInProgressError) {
        throw err;
      }

      if (creationToken && !newWorkItemPublished) {
        await this.debounce.abandonPendingWorkItem(component_id, creationToken).catch(() => {});
      }

      await this.ingestLedger.markFailed(signal_id, err?.message || 'Unknown processing error');
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
      'MAX_ATTEMPTS_EXCEEDED',
      reason,
      attemptCount,
    );

    if (!persisted) {
      throw new Error(`DLQ handoff failed for signal ${signal.signal_id}`);
    }

    await this.ingestLedger.markDeadLettered(signal.signal_id, reason);
    DebugLogger.log('SignalProcessor', `Signal ${signal.signal_id} moved to DLQ`, {
      attemptCount,
      reason,
    });
  }
}
