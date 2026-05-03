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
   * Insert many raw signal documents (unordered for partial-failure tolerance).
   */
  async insertManyRaw(docs: Record<string, any>[]): Promise<any> {
    return this.mongo.signalsRaw.insertMany(docs, { ordered: false });
  }

  /**
   * Link a raw signal to a work item by updating its linked_work_item_id.
   */
  async linkSignalToWorkItem(signalId: string, workItemExternalId: string): Promise<void> {
    await this.mongo.signalsRaw.updateOne(
      { signal_id: signalId },
      { $set: { linked_work_item_id: workItemExternalId } },
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
    const [data, total] = await Promise.all([
      this.mongo.signalsRaw
        .find({ linked_work_item_id: workItemExternalId })
        .sort({ received_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.mongo.signalsRaw.countDocuments({ linked_work_item_id: workItemExternalId }),
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

