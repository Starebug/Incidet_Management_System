import { Injectable } from '@nestjs/common';
import { MongoService } from '../common/database/mongo.service';

/**
 * DlqService — Dead Letter Queue
 *
 * Stores permanently failed signals for investigation.
 * Uses MongoDB dead_letter_queue collection with 7-day TTL.
 */
@Injectable()
export class DlqService {
  constructor(private readonly mongo: MongoService) {}

  /**
   * Write a failed signal to the dead letter queue.
   */
  async send(
    signalData: Record<string, any>,
    errorType: string,
    errorMessage: string,
    attemptCount: number,
  ): Promise<void> {
    try {
      await this.mongo.deadLetterQueue.insertOne({
        signal_id: signalData.signal_id || 'unknown',
        payload: signalData,
        error_type: errorType,
        error_message: errorMessage,
        attempt_count: attemptCount,
        first_attempt_at: new Date(),
        last_attempt_at: new Date(),
        created_at: new Date(),
      });
    } catch (err) {
      // If even DLQ write fails, just log — we can't recurse forever
      console.error('[DLQ] Failed to write to dead letter queue:', err);
    }
  }

  /**
   * Get DLQ depth (for metrics/health).
   */
  async getDepth(): Promise<number> {
    try {
      return await this.mongo.deadLetterQueue.countDocuments();
    } catch {
      return -1;
    }
  }
}

