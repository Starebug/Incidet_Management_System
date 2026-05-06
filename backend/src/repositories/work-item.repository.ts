import { Injectable } from '@nestjs/common';
import { PostgresService } from '@/common/database/postgres.service';
import { PoolClient } from 'pg';

export interface CreateWorkItemParams {
  externalId: string;
  componentId: string;
  serviceType: string;
  severity: string;
  firstSignalAt: Date;
  lastSignalAt: Date;
}

export interface ListWorkItemsFilters {
  status?: string;
  severity?: string;
  componentId?: string;
  page: number;
  limit: number;
}

export interface DashboardIncidentSummary {
  external_id: string;
  component_id: string;
  service_type: string;
  severity: string;
  status: string;
  first_signal_at: Date;
  last_signal_at: Date;
  signal_count: number;
  updated_at: Date;
}

/**
 * WorkItemRepository
 *
 * Cleanly encapsulates all PostgreSQL data-access operations for work_items,
 * status_history, and rca_records. All mutations are transactional.
 * No business logic lives here — only data access.
 */
@Injectable()
export class WorkItemRepository {
  constructor(private readonly pg: PostgresService) {}

  // ─── Work Item CRUD ────────────────────────────────────────────────

  /**
   * Create a new work item with initial OPEN status + status history entry.
   * Runs in a single transaction.
   */
  async create(params: CreateWorkItemParams): Promise<void> {
    const client = await this.pg.getClient();

    try {
      await client.query('BEGIN');

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
        console.log(`[WorkItemRepo] Duplicate external_id ${params.externalId}, treating as existing`);
        return;
      }

      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Increment signal_count and update last_signal_at for an existing work item.
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

  /**
   * Find a single work item by external_id.
   */
  async findByExternalId(externalId: string): Promise<any | null> {
    const result = await this.pg.query(
      `SELECT id, external_id, component_id, service_type, severity, status,
              first_signal_at, last_signal_at, signal_count, closed_at,
              mttr_seconds, version, created_at, updated_at
       FROM work_items
       WHERE external_id = $1`,
      [externalId],
    );
    return result.rows[0] || null;
  }

  /**
   * Find the minimal dashboard projection row for a single incident.
   */
  async findDashboardSummaryByExternalId(externalId: string): Promise<DashboardIncidentSummary | null> {
    const result = await this.pg.query(
      `SELECT external_id, component_id, service_type, severity, status,
              first_signal_at, last_signal_at, signal_count, updated_at
       FROM work_items
       WHERE external_id = $1`,
      [externalId],
    );

    return result.rows[0] || null;
  }

  /**
   * Find dashboard projection rows for a set of incident IDs.
   */
  async findDashboardSummariesByExternalIds(
    externalIds: string[],
    status?: string,
  ): Promise<DashboardIncidentSummary[]> {
    if (externalIds.length === 0) {
      return [];
    }

    const params: any[] = [externalIds];
    let whereClause = 'WHERE external_id = ANY($1::uuid[])';

    if (status) {
      params.push(status);
      whereClause += ` AND status = $${params.length}`;
    } else {
      whereClause += ` AND status != 'CLOSED'`;
    }

    const result = await this.pg.query(
      `SELECT external_id, component_id, service_type, severity, status,
              first_signal_at, last_signal_at, signal_count, updated_at
       FROM work_items
       ${whereClause}`,
      params,
    );

    return result.rows;
  }

  /**
   * Get internal ID by external_id.
   */
  async getInternalId(externalId: string): Promise<number | null> {
    const result = await this.pg.query(
      'SELECT id FROM work_items WHERE external_id = $1',
      [externalId],
    );
    return result.rows[0]?.id || null;
  }

  /**
   * List work items with filtering and pagination.
   */
  async findAll(filters: ListWorkItemsFilters): Promise<{ rows: any[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }
    if (filters.severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(filters.severity);
    }
    if (filters.componentId) {
      conditions.push(`component_id = $${paramIdx++}`);
      params.push(filters.componentId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (filters.page - 1) * filters.limit;

    const countResult = await this.pg.query(
      `SELECT COUNT(*) FROM work_items ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await this.pg.query(
      `SELECT external_id, component_id, service_type, severity, status,
              first_signal_at, last_signal_at, signal_count, closed_at,
              mttr_seconds, created_at, updated_at
       FROM work_items
       ${whereClause}
       ORDER BY
         CASE severity
           WHEN 'P0' THEN 0
           WHEN 'P1' THEN 1
           WHEN 'P2' THEN 2
           WHEN 'P3' THEN 3
         END ASC,
         updated_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, filters.limit, offset],
    );

    return { rows: dataResult.rows, total };
  }

  /**
   * Get status transition history for an incident.
   */
  async findStatusHistory(externalId: string): Promise<any[]> {
    const result = await this.pg.query(
      `SELECT sh.id, sh.from_status, sh.to_status, sh.reason, sh.changed_by, sh.changed_at
       FROM status_history sh
       JOIN work_items wi ON wi.id = sh.work_item_id
       WHERE wi.external_id = $1
       ORDER BY sh.changed_at DESC`,
      [externalId],
    );
    return result.rows;
  }

  /**
   * Get severity for an incident by external_id.
   */
  async getSeverity(externalId: string): Promise<string | null> {
    const result = await this.pg.query(
      `SELECT severity FROM work_items WHERE external_id = $1`,
      [externalId],
    );
    return result.rows[0]?.severity || null;
  }

  // ─── Transactional Workflow Operations ─────────────────────────────

  /**
   * Acquire a Postgres client for transactional operations.
   */
  async getClient(): Promise<PoolClient> {
    return this.pg.getClient();
  }

  /**
   * Lock a work item row for update (used in workflow transitions).
   */
  async lockForUpdate(client: PoolClient, externalId: string): Promise<any | null> {
    const result = await client.query(
      `SELECT id, status, severity, version, first_signal_at
       FROM work_items
       WHERE external_id = $1
       FOR UPDATE`,
      [externalId],
    );
    return result.rows[0] || null;
  }

  /**
   * Update work item status (standard transition).
   */
  async updateStatus(client: PoolClient, id: number, status: string): Promise<void> {
    await client.query(
      `UPDATE work_items
       SET status = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2`,
      [status, id],
    );
  }

  /**
   * Close a work item with MTTR calculation.
   */
  async closeWithMttr(client: PoolClient, id: number, status: string, mttrSeconds: number): Promise<void> {
    await client.query(
      `UPDATE work_items
       SET status = $1, closed_at = NOW(), mttr_seconds = $2,
           version = version + 1, updated_at = NOW()
       WHERE id = $3`,
      [status, mttrSeconds, id],
    );
  }

  /**
   * Insert a status history entry.
   */
  async insertStatusHistory(
    client: PoolClient,
    workItemId: number,
    fromStatus: string | null,
    toStatus: string,
    reason: string | null,
    changedBy: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO status_history (work_item_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [workItemId, fromStatus, toStatus, reason, changedBy],
    );
  }

  // ─── RCA Operations ────────────────────────────────────────────────

  /**
   * Find RCA record by work item internal ID.
   */
  async findRcaByWorkItemId(workItemId: number): Promise<any | null> {
    const result = await this.pg.query(
      `SELECT id, incident_start, incident_end, root_cause_category, fix_applied, prevention_steps
       FROM rca_records
       WHERE work_item_id = $1`,
      [workItemId],
    );
    return result.rows[0] || null;
  }

  /**
   * Find RCA record by incident external_id (join).
   */
  async findRcaByExternalId(externalId: string): Promise<any | null> {
    const result = await this.pg.query(
      `SELECT r.id, r.incident_start, r.incident_end, r.root_cause_category,
              r.fix_applied, r.prevention_steps, r.created_by, r.created_at, r.updated_at
       FROM rca_records r
       JOIN work_items wi ON wi.id = r.work_item_id
       WHERE wi.external_id = $1`,
      [externalId],
    );
    return result.rows[0] || null;
  }

  /**
   * Insert a new RCA record.
   */
  async insertRca(
    workItemId: number,
    incidentStart: string,
    incidentEnd: string,
    rootCauseCategory: string,
    fixApplied: string,
    preventionSteps: string,
    createdBy: string,
  ): Promise<any> {
    const result = await this.pg.query(
      `INSERT INTO rca_records
         (work_item_id, incident_start, incident_end, root_cause_category,
          fix_applied, prevention_steps, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, incident_start, incident_end, root_cause_category,
                 fix_applied, prevention_steps, created_by, created_at`,
      [workItemId, incidentStart, incidentEnd, rootCauseCategory, fixApplied, preventionSteps, createdBy],
    );
    return result.rows[0];
  }

  /**
   * Update MTTR on a work item.
   */
  async updateMttr(workItemId: number, mttrSeconds: number): Promise<void> {
    await this.pg.query(
      'UPDATE work_items SET mttr_seconds = $1, updated_at = NOW() WHERE id = $2',
      [mttrSeconds, workItemId],
    );
  }

  // ─── Dashboard / Stats Queries ─────────────────────────────────────

  /**
   * Get live feed from Postgres (fallback when cache is cold).
   */
  async findLiveFeed(status?: string, limit = 100): Promise<any[]> {
    const params: any[] = [];
    const statusFilter = status
      ? `WHERE status = $${params.push(status)}`
      : `WHERE status != 'CLOSED'`;
    const limitParam = `$${params.push(limit)}`;

    const result = await this.pg.query(
      `SELECT external_id, component_id, service_type, severity, status,
              first_signal_at, last_signal_at, signal_count, updated_at
       FROM work_items
       ${statusFilter}
       ORDER BY
         CASE severity
           WHEN 'P0' THEN 0
           WHEN 'P1' THEN 1
           WHEN 'P2' THEN 2
           WHEN 'P3' THEN 3
         END ASC,
         updated_at DESC
       LIMIT ${limitParam}`,
      params,
    );

    return result.rows;
  }

  /**
   * Aggregated dashboard statistics.
   */
  async getStats(): Promise<{
    statusCounts: any[];
    severityCounts: any[];
    mttrStats: any[];
    recentClosed: any[];
  }> {
    const [statusCounts, severityCounts, mttrStats, recentClosed] = await Promise.all([
      this.pg.query(`SELECT status, COUNT(*) as count FROM work_items GROUP BY status`),
      this.pg.query(`SELECT severity, COUNT(*) as count FROM work_items GROUP BY severity`),
      this.pg.query(
        `SELECT
           severity,
           AVG(mttr_seconds) as avg_mttr,
           MIN(mttr_seconds) as min_mttr,
           MAX(mttr_seconds) as max_mttr,
           COUNT(*) as closed_count
         FROM work_items
         WHERE mttr_seconds IS NOT NULL
         GROUP BY severity`,
      ),
      this.pg.query(
        `SELECT external_id, component_id, severity, mttr_seconds, closed_at
         FROM work_items
         WHERE status = 'CLOSED'
         ORDER BY closed_at DESC
         LIMIT 10`,
      ),
    ]);

    return {
      statusCounts: statusCounts.rows,
      severityCounts: severityCounts.rows,
      mttrStats: mttrStats.rows,
      recentClosed: recentClosed.rows,
    };
  }
}

