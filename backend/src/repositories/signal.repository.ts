import { Injectable } from '@nestjs/common';
import { MongoService } from '@/common/database/mongo.service';

/**
 * SignalRepository
 *
 * Cleanly encapsulates all MongoDB data-access operations for signals
 * and the dead letter queue. No business logic lives here.
 */
@Injectable()
export class SignalRepository {
  constructor(private readonly mongo: MongoService) {}

  /**
   * Persist one raw signal document idempotently.
   * The audit worker writes the final linked_work_item_id in the same operation,
   * so no follow-up Mongo patch is required from the business pipeline.
   */
  async upsertRawSignal(doc: Record<string, any>): Promise<void> {
    await this.mongo.signalsRaw.updateOne(
      { signal_id: doc.signal_id },
      { $set: doc },
      { upsert: true },
    );
  }

  /**
   * Find signals linked to a specific work item, with pagination.
   */
  async findByWorkItemId(
    workItemExternalId: string,
    skip: number,
    limit: number,
  ): Promise<{ data: any[]; total: number }> {
    const signalsRawRead = this.mongo.signalsRawReplicaRead;

    const [data, total] = await Promise.all([
      signalsRawRead
        .find({ linked_work_item_id: workItemExternalId })
        .sort({ received_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      signalsRawRead.countDocuments({ linked_work_item_id: workItemExternalId }),
    ]);

    return { data, total };
  }

  /**
   * Write a failed signal to the dead letter queue.
   */
  async insertDlqEntry(entry: Record<string, any>): Promise<void> {
    await this.mongo.deadLetterQueue.insertOne(entry);
  }

  /**
   * Get the count of entries in the dead letter queue.
   */
  async getDlqDepth(): Promise<number> {
    return this.mongo.deadLetterQueue.countDocuments();
  }
}

