import { Injectable } from '@nestjs/common';
import { SignalRepository } from '@/repositories';
import { DebounceService } from './debounce.service';
import { WorkItemService } from './work-item.service';
import { AlertStrategyResolver } from './alerting/alert-strategy.resolver';
import { DashboardCacheService } from './dashboard-cache.service';
import { DlqService } from './dlq.service';
import { RawSignalBatchWriter } from './raw-signal-batch-writer.service';
import { DebugLogger } from '@/common/utils/debug-logger';

/**
 * SignalProcessor
 *
 * Orchestrates the full processing pipeline for one signal:
 *
 *   1. Write raw signal to MongoDB via batched writer (audit lake)
 *   2. Resolve debounce (reuse or create work item)
 *   3. Create/update Postgres work item
 *   4. Link raw signal to work item in MongoDB
 *   5. Determine alert severity (Strategy Pattern)
 *   6. Update Redis dashboard cache
 *
 * Never calls a DB driver directly — all data access via repositories.
 * Idempotency: duplicate signal_id in Mongo = already processed → skip.
 */
@Injectable()
export class SignalProcessor {
  constructor(
    private readonly signalRepo: SignalRepository,
    private readonly debounce: DebounceService,
    private readonly workItem: WorkItemService,
    private readonly alertResolver: AlertStrategyResolver,
    private readonly dashboardCache: DashboardCacheService,
    private readonly dlq: DlqService,
    private readonly batchWriter: RawSignalBatchWriter,
  ) {}

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

    // Parse payload from JSON string
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(payloadStr || '{}');
    } catch {
      payload = {};
    }

    // ─── Step 1: Write raw signal to MongoDB (batched) ────────────
    const isDuplicate = await this.batchWriter.enqueue({
      signal_id,
      component_id,
      service_type,
      severity: rawSeverity,
      event_ts: new Date(event_ts),
      received_at: new Date(received_at),
      payload,
      trace_id: trace_id || undefined,
      linked_work_item_id: null, // Will be updated after debounce
    });

    // If this exact signal was already persisted, skip further processing
    if (isDuplicate) {
      DebugLogger.log('SignalProcessor', `Duplicate signal ${signal_id}, skipping`);
      return;
    }

    // ─── Step 2: Determine alert severity via Strategy Pattern ─────
    const alertStrategy = this.alertResolver.resolve(service_type);
    const severity = alertStrategy.determineSeverity({
      service_type,
      component_id,
      payload,
      rawSeverity,
    });

    // ─── Step 3: Resolve debounce (get or create work item) ────────
    const { workItemExternalId, isNew } = await this.debounce.resolveWorkItem(
      component_id,
      service_type,
      severity,
      new Date(event_ts),
    );

    // ─── Step 4: Update work item in Postgres ──────────────────────
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

      await this.dashboardCache.onIncidentCreated(
        workItemExternalId,
        component_id,
        service_type,
        severity,
        new Date(event_ts).toISOString(),
      );
    } else {
      // Update existing: increment signal count, update last_signal_at
      await this.workItem.addSignal(workItemExternalId, new Date(event_ts));
    }

    // ─── Step 5: Link raw signal to work item in MongoDB ───────────
    await this.signalRepo.linkSignalToWorkItem(signal_id, workItemExternalId);

    // ─── Step 6: Update dashboard hot cache ────────────────────────
    await this.dashboardCache.onSignalProcessed(workItemExternalId, severity, isNew);

    DebugLogger.log('SignalProcessor', `Processed signal ${signal_id}`, {
      component_id,
      service_type,
      severity,
      workItemExternalId,
      isNew,
      durationMs: Date.now() - startedAt,
    });
  }
}
