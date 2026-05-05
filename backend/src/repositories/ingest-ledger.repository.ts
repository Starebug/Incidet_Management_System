import { Injectable } from '@nestjs/common';
import { PostgresService } from '@/common/database/postgres.service';

export interface BeginProcessingResult {
  disposition: 'PROCESS' | 'ALREADY_PROCESSED' | 'LEASE_HELD';
  attemptCount: number;
  leaseAgeMs?: number;
}

/**
 * IngestLedgerRepository
 *
 * Tracks end-to-end processing state for each signal_id.
 * This is the authoritative idempotency ledger for ingestion retries.
 *
 * IMPORTANT:
 * - MongoDB signals_raw existence means "audit persisted"
 * - ingest_dedup.status = PROCESSED means "fully processed end-to-end"
 * - ingest_dedup.status = DLQ means "terminally failed and handed off"
 */
@Injectable()
export class IngestLedgerRepository {
  private readonly processingLeaseMs: number;

  constructor(private readonly pg: PostgresService) {
    this.processingLeaseMs = parseInt(process.env.INGEST_PROCESSING_LEASE_MS || '60000', 10);
  }

  /**
   * Begin or resume processing for a signal.
   *
   * Returns one of three dispositions:
   * - PROCESS            → caller owns the lease and should run the pipeline
   * - ALREADY_PROCESSED  → signal completed end-to-end earlier; safe to skip
   * - LEASE_HELD         → another worker still has a fresh processing lease
   */
  async beginProcessing(signalId: string): Promise<BeginProcessingResult> {
    const client = await this.pg.getClient();

    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO ingest_dedup
           (signal_id, status, received_at, processing_started_at, attempt_count, updated_at)
         VALUES ($1, 'PROCESSING', NOW(), NOW(), 1, NOW())
         ON CONFLICT (signal_id) DO NOTHING
         RETURNING signal_id`,
        [signalId],
      );

      if ((insertResult.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return {
          disposition: 'PROCESS',
          attemptCount: 1,
        };
      }

      const result = await client.query(
        `SELECT status, processed_at, attempt_count, processing_started_at
         FROM ingest_dedup
         WHERE signal_id = $1
         FOR UPDATE`,
        [signalId],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to load ingest ledger row for signal ${signalId}`);
      }

      if (row.processed_at || row.status === 'PROCESSED' || row.status === 'DLQ') {
        await client.query('COMMIT');
        return {
          disposition: 'ALREADY_PROCESSED',
          attemptCount: row.attempt_count,
        };
      }

      const leaseAgeMs = row.processing_started_at
        ? Date.now() - new Date(row.processing_started_at).getTime()
        : null;

      if (row.status === 'PROCESSING' && leaseAgeMs !== null && leaseAgeMs < this.processingLeaseMs) {
        await client.query('COMMIT');
        return {
          disposition: 'LEASE_HELD',
          attemptCount: row.attempt_count,
          leaseAgeMs,
        };
      }

      const nextAttemptCount = Number(row.attempt_count || 0) + 1;

      await client.query(
        `UPDATE ingest_dedup
         SET status = 'PROCESSING',
             processing_started_at = NOW(),
             attempt_count = $2,
             last_error = NULL,
             updated_at = NOW()
         WHERE signal_id = $1`,
        [signalId, nextAttemptCount],
      );

      await client.query('COMMIT');
      return {
        disposition: 'PROCESS',
        attemptCount: nextAttemptCount,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Mark signal as fully processed only after all downstream side effects succeed.
   */
  async markProcessed(signalId: string): Promise<void> {
    await this.pg.query(
      `UPDATE ingest_dedup
       SET status = 'PROCESSED',
           processed_at = NOW(),
           processing_started_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE signal_id = $1`,
      [signalId],
    );
  }

  /**
   * Mark signal as terminally failed and handed off to the DLQ.
   */
  async markDeadLettered(signalId: string, errorMessage: string): Promise<void> {
    await this.pg.query(
      `UPDATE ingest_dedup
       SET status = 'DLQ',
           processing_started_at = NULL,
           last_error = LEFT($2, 2000),
           updated_at = NOW()
       WHERE signal_id = $1`,
      [signalId, errorMessage],
    );
  }

  /**
   * Mark a processing attempt as failed while keeping the signal retryable.
   */
  async markFailed(signalId: string, errorMessage: string): Promise<void> {
    await this.pg.query(
      `UPDATE ingest_dedup
       SET status = 'FAILED',
           processing_started_at = NULL,
           last_error = LEFT($2, 2000),
           updated_at = NOW()
       WHERE signal_id = $1`,
      [signalId, errorMessage],
    );
  }
}





