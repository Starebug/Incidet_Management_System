import { Injectable } from '@nestjs/common';
import { PostgresService } from '../common/database/postgres.service';

interface CreateWorkItemParams {
  externalId: string;
  componentId: string;
  serviceType: string;
  severity: string;
  firstSignalAt: Date;
  lastSignalAt: Date;
}

/**
 * WorkItemService
 *
 * Manages Postgres work_items lifecycle for the worker.
 * All writes are transactional (work_item + status_history together).
 */
@Injectable()
export class WorkItemService {
  constructor(private readonly pg: PostgresService) {}

  /**
   * Create a new work item with initial OPEN status + status history entry.
   * Runs in a single transaction.
   */
  async create(params: CreateWorkItemParams): Promise<void> {
    const client = await this.pg.getClient();

    try {
      await client.query('BEGIN');

      // Insert work item
      const result = await client.query(
        `INSERT INTO work_items
           (external_id, component_id, service_type, severity, status,
            first_signal_at, last_signal_at, signal_count)
         VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, 1)
         RETURNING id`,
        [
          params.externalId,
          params.componentId,
          params.serviceType,
          params.severity,
          params.firstSignalAt,
          params.lastSignalAt,
        ],
      );

      const workItemId = result.rows[0].id;

      // Insert initial status history
      await client.query(
        `INSERT INTO status_history
           (work_item_id, from_status, to_status, reason, changed_by)
         VALUES ($1, NULL, 'OPEN', 'Auto-created from incoming signal', 'system')`,
        [workItemId],
      );

      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');

      // Duplicate external_id — another worker created it first (race condition recovery)
      if (err.code === '23505' && err.constraint?.includes('external_id')) {
        console.log(`[WorkItem] Duplicate external_id ${params.externalId}, treating as existing`);
        return;
      }

      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Add a signal to an existing work item.
   * Increments signal_count and updates last_signal_at.
   */
  async addSignal(externalId: string, signalTime: Date): Promise<void> {
    await this.pg.query(
      `UPDATE work_items
       SET signal_count = signal_count + 1,
           last_signal_at = GREATEST(last_signal_at, $1),
           updated_at = NOW()
       WHERE external_id = $2`,
      [signalTime, externalId],
    );
  }

  /**
   * Find active (non-CLOSED) work item for a given component.
   * Useful for post-debounce-window reuse of open incidents.
   */
  async findActiveByComponent(componentId: string): Promise<{ external_id: string } | null> {
    const result = await this.pg.query(
      `SELECT external_id
       FROM work_items
       WHERE component_id = $1 AND status != 'CLOSED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [componentId],
    );
    return result.rows[0] || null;
  }
}

