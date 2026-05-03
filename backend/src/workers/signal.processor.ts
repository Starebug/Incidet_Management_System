import { Injectable } from '@nestjs/common';
import { MongoService } from '../common/database/mongo.service';
import { DebounceService } from './debounce.service';
import { WorkItemService } from './work-item.service';
import { AlertStrategyResolver } from './alerting/alert-strategy.resolver';
import { DashboardCacheService } from './dashboard-cache.service';
import { DlqService } from './dlq.service';

/**
 * SignalProcessor
 *
 * Orchestrates the full processing pipeline for one signal:
 *
 *   1. Write raw signal to MongoDB (audit lake)
 *   2. Resolve debounce (reuse or create work item)
 *   3. Create/update Postgres work item
 *   4. Link raw signal to work item in MongoDB
 *   5. Determine alert severity (Strategy Pattern)
 *   6. Update Redis dashboard cache
 *
 * Idempotency: duplicate signal_id in Mongo = already processed → skip.
 */
@Injectable()
export class SignalProcessor {
  constructor(
    private readonly mongo: MongoService,
    private readonly debounce: DebounceService,
    private readonly workItem: WorkItemService,
    private readonly alertResolver: AlertStrategyResolver,
    private readonly dashboardCache: DashboardCacheService,
    private readonly dlq: DlqService,
  ) {}

  /**
   * Process a single signal end-to-end.
   * @param signal - Parsed fields from Redis Stream message
   */
  async process(signal: Record<string, string>): Promise<void> {
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

    // ─── Step 1: Write raw signal to MongoDB ───────────────────────
    const isDuplicate = await this.writeRawSignal({
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
      console.log(`[Processor] Duplicate signal ${signal_id}, skipping`);
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
    } else {
      // Update existing: increment signal count, update last_signal_at
      await this.workItem.addSignal(workItemExternalId, new Date(event_ts));
    }

    // ─── Step 5: Link raw signal to work item in MongoDB ───────────
    await this.linkSignalToWorkItem(signal_id, workItemExternalId);

    // ─── Step 6: Update dashboard hot cache ────────────────────────
    await this.dashboardCache.onSignalProcessed(workItemExternalId, severity, isNew);
  }

  /**
   * Insert raw signal into MongoDB.
   * Returns true if signal already existed (duplicate).
   */
  private async writeRawSignal(doc: Record<string, any>): Promise<boolean> {
    try {
      await this.mongo.signalsRaw.insertOne(doc);
      return false;
    } catch (err: any) {
      // Duplicate key error (code 11000) = signal already exists
      if (err.code === 11000) {
        return true;
      }
      throw err; // Re-throw other errors
    }
  }

  /**
   * Update the raw signal document in MongoDB with the linked work item ID.
   */
  private async linkSignalToWorkItem(
    signalId: string,
    workItemExternalId: string,
  ): Promise<void> {
    await this.mongo.signalsRaw.updateOne(
      { signal_id: signalId },
      { $set: { linked_work_item_id: workItemExternalId } },
    );
  }
}

