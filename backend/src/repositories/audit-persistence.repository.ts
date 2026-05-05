import { Injectable } from '@nestjs/common';
import { PostgresService } from '@/common/database/postgres.service';

export interface ScheduleAuditPersistenceResult {
  disposition: 'ENQUEUE' | 'ALREADY_SCHEDULED' | 'ALREADY_PERSISTED' | 'ALREADY_DEAD_LETTERED';
}

export interface BeginAuditPersistenceResult {
  disposition: 'PROCESS' | 'ALREADY_PERSISTED' | 'LEASE_HELD' | 'ALREADY_DEAD_LETTERED';
  attemptCount: number;
  leaseAgeMs?: number;
  workItemExternalId?: string;
}

/**
 * AuditPersistenceRepository
 *
 * Tracks the asynchronous MongoDB audit-persistence pipeline separately from the
 * main ingest ledger. Business processing can complete once the audit task is
 * durably scheduled, while audit retries and failures are tracked independently.
 */
@Injectable()
export class AuditPersistenceRepository {
  private readonly processingLeaseMs: number;

  constructor(private readonly pg: PostgresService) {
    this.processingLeaseMs = parseInt(process.env.AUDIT_PROCESSING_LEASE_MS || '60000', 10);
  }

  /**
   * Create or refresh a pending audit task for a signal.
   *
   * Returns ENQUEUE only when a fresh audit-stream message should be published.
   * Existing PENDING / PROCESSING rows remain scheduled and should not be
   * duplicated on the audit stream.
   */
  async schedule(signalId: string, workItemExternalId: string): Promise<ScheduleAuditPersistenceResult> {
    const client = await this.pg.getClient();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT status
         FROM audit_signal_persistence
         WHERE signal_id = $1
         FOR UPDATE`,
        [signalId],
      );

      const row = result.rows[0];
      if (!row) {
        await client.query(
          `INSERT INTO audit_signal_persistence
             (signal_id, work_item_external_id, status, created_at, updated_at)
           VALUES ($1, $2, 'PENDING', NOW(), NOW())`,
          [signalId, workItemExternalId],
        );
        await client.query('COMMIT');
        return { disposition: 'ENQUEUE' };
      }

      if (row.status === 'PERSISTED') {
        await client.query(
          `UPDATE audit_signal_persistence
           SET work_item_external_id = $2,
               updated_at = NOW()
           WHERE signal_id = $1`,
          [signalId, workItemExternalId],
        );
        await client.query('COMMIT');
        return { disposition: 'ALREADY_PERSISTED' };
      }

      if (row.status === 'DLQ') {
        await client.query('COMMIT');
        return { disposition: 'ALREADY_DEAD_LETTERED' };
      }

      if (row.status === 'FAILED') {
        await client.query(
          `UPDATE audit_signal_persistence
           SET work_item_external_id = $2,
               status = 'PENDING',
               processing_started_at = NULL,
               last_error = NULL,
               updated_at = NOW()
           WHERE signal_id = $1`,
          [signalId, workItemExternalId],
        );
        await client.query('COMMIT');
        return { disposition: 'ENQUEUE' };
      }

      await client.query(
        `UPDATE audit_signal_persistence
         SET work_item_external_id = $2,
             updated_at = NOW()
         WHERE signal_id = $1`,
        [signalId, workItemExternalId],
      );
      await client.query('COMMIT');
      return { disposition: 'ALREADY_SCHEDULED' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Acquire or resume the audit-processing lease for a signal.
   */
  async beginProcessing(signalId: string): Promise<BeginAuditPersistenceResult> {
    const client = await this.pg.getClient();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT status, attempt_count, processing_started_at, work_item_external_id
         FROM audit_signal_persistence
         WHERE signal_id = $1
         FOR UPDATE`,
        [signalId],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to load audit persistence ledger row for signal ${signalId}`);
      }

      if (row.status === 'PERSISTED') {
        await client.query('COMMIT');
        return {
          disposition: 'ALREADY_PERSISTED',
          attemptCount: row.attempt_count,
          workItemExternalId: row.work_item_external_id,
        };
      }

      if (row.status === 'DLQ') {
        await client.query('COMMIT');
        return {
          disposition: 'ALREADY_DEAD_LETTERED',
          attemptCount: row.attempt_count,
          workItemExternalId: row.work_item_external_id,
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
          workItemExternalId: row.work_item_external_id,
        };
      }

      const nextAttemptCount = Number(row.attempt_count || 0) + 1;
      await client.query(
        `UPDATE audit_signal_persistence
         SET status = 'PROCESSING',
             attempt_count = $2,
             processing_started_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE signal_id = $1`,
        [signalId, nextAttemptCount],
      );

      await client.query('COMMIT');
      return {
        disposition: 'PROCESS',
        attemptCount: nextAttemptCount,
        workItemExternalId: row.work_item_external_id,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markPersisted(signalId: string): Promise<void> {
    await this.pg.query(
      `UPDATE audit_signal_persistence
       SET status = 'PERSISTED',
           persisted_at = NOW(),
           processing_started_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE signal_id = $1`,
      [signalId],
    );
  }

  async markFailed(signalId: string, errorMessage: string): Promise<void> {
    await this.pg.query(
      `UPDATE audit_signal_persistence
       SET status = 'FAILED',
           processing_started_at = NULL,
           last_error = LEFT($2, 2000),
           updated_at = NOW()
       WHERE signal_id = $1`,
      [signalId, errorMessage],
    );
  }

  async markDeadLettered(signalId: string, errorMessage: string): Promise<void> {
    await this.pg.query(
      `UPDATE audit_signal_persistence
       SET status = 'DLQ',
           processing_started_at = NULL,
           last_error = LEFT($2, 2000),
           updated_at = NOW()
       WHERE signal_id = $1`,
      [signalId, errorMessage],
    );
  }
}

