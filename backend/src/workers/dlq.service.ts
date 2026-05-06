import { Injectable } from '@nestjs/common';
import { SignalRepository } from '@/repositories';

/**
 * DlqService — Dead Letter Queue
 *
 * Stores permanently failed signals for investigation.
 * Delegates all data access to SignalRepository.
 * No direct DB driver calls.
 */
@Injectable()
export class DlqService {
  constructor(private readonly signalRepo: SignalRepository) {}

  /**
   * Write a failed signal to the dead letter queue.
   */
  async send(
    signalData: Record<string, any>,
    errorType: string,
    errorMessage: string,
    attemptCount: number,
  ): Promise<boolean> {
    try {
      await this.signalRepo.insertDlqEntry({
        signal_id: signalData.signal_id || 'unknown',
        payload: signalData,
        error_type: errorType,
        error_message: errorMessage,
        attempt_count: attemptCount,
        first_attempt_at: new Date(),
        last_attempt_at: new Date(),
        created_at: new Date(),
      });
      return true;
    } catch (err) {
      // If even DLQ write fails, surface that so the caller does NOT ack.
      console.error('[DLQ] Failed to write to dead letter queue:', err);
      return false;
    }
  }
}
