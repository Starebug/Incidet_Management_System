import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { SignalRepository } from '@/repositories';

/**
 * Pending entry: one signal doc waiting to be flushed.
 * Carries a resolve/reject so the caller can await insertion result.
 */
interface PendingEntry {
  doc: Record<string, any>;
  resolve: (isDuplicate: boolean) => void;
  reject: (err: Error) => void;
}

/**
 * RawSignalBatchWriter
 *
 * Buffers raw signal documents in memory and flushes them to MongoDB
 * via SignalRepository using batched insertMany.
 *
 * Flush triggers:
 *   - buffer reaches BATCH_SIZE (default 100)
 *   - flush interval timer fires (default 1000 ms)
 *
 * Each caller gets a promise that resolves with:
 *   - false = inserted successfully (not a duplicate)
 *   - true  = duplicate (Mongo error code 11000)
 *
 * On non-duplicate errors, the caller's promise is rejected.
 *
 * Graceful shutdown: flushes remaining buffer on module destroy.
 */
@Injectable()
export class RawSignalBatchWriter implements OnModuleDestroy {
  private buffer: PendingEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  private readonly BATCH_SIZE: number;
  private readonly FLUSH_INTERVAL_MS: number;

  constructor(private readonly signalRepo: SignalRepository) {
    this.BATCH_SIZE = parseInt(process.env.MONGO_BATCH_SIZE || '100', 10);
    this.FLUSH_INTERVAL_MS = parseInt(process.env.MONGO_FLUSH_INTERVAL_MS || '200', 10);

    // Start periodic flush timer
    this.flushTimer = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);
  }

  /**
   * Enqueue a raw signal document for batched insertion.
   * Returns a promise that resolves when the doc is persisted.
   *
   * @returns true if duplicate, false if inserted successfully
   */
  enqueue(doc: Record<string, any>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.buffer.push({ doc, resolve, reject });

      // Flush immediately if batch is full
      if (this.buffer.length >= this.BATCH_SIZE) {
        this.flush();
      }
    });
  }

  /**
   * Flush the current buffer to MongoDB via SignalRepository.
   * Uses unordered insertMany so one duplicate doesn't fail the whole batch.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;

    this.flushing = true;

    // Swap buffer so new enqueues go to a fresh array
    const batch = this.buffer;
    this.buffer = [];

    try {
      const docs = batch.map(entry => entry.doc);

      await this.signalRepo.insertManyRaw(docs);

      // All succeeded — resolve everyone as not-duplicate
      for (const entry of batch) {
        entry.resolve(false);
      }
    } catch (err: any) {
      // With ordered: false, Mongo inserts as many as possible and
      // reports failures in err.writeErrors
      if (err.code === 11000 || (err.writeErrors && err.writeErrors.length > 0)) {
        this.handlePartialFailure(batch, err);
      } else {
        // Total failure — reject all
        for (const entry of batch) {
          entry.reject(err);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Handle partial insert failure from unordered insertMany.
   * Duplicates (11000) resolve as true; other errors reject.
   */
  private handlePartialFailure(batch: PendingEntry[], err: any): void {
    // Build a set of failed indexes
    const failedIndexes = new Map<number, any>();

    const writeErrors = err.writeErrors || err.result?.writeErrors || [];
    for (const writeErr of writeErrors) {
      failedIndexes.set(writeErr.index, writeErr);
    }

    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i];
      const writeErr = failedIndexes.get(i);

      if (!writeErr) {
        // This doc was inserted successfully
        entry.resolve(false);
      } else if (writeErr.code === 11000) {
        // Duplicate — resolve as isDuplicate=true
        entry.resolve(true);
      } else {
        // Non-duplicate error — reject
        entry.reject(new Error(writeErr.errmsg || 'Mongo write error'));
      }
    }
  }

  /**
   * Graceful shutdown: flush remaining buffer.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    await this.flush();
  }

  /**
   * Current buffer size (for metrics/monitoring).
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}
