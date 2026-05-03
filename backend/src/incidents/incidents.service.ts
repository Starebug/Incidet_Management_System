import { Injectable } from '@nestjs/common';
import { PostgresService } from '../common/database/postgres.service';
import { MongoService } from '../common/database/mongo.service';

interface ListFilters {
  status?: string;
  severity?: string;
  componentId?: string;
  page: number;
  limit: number;
}

@Injectable()
export class IncidentsService {
  constructor(
    private readonly pg: PostgresService,
    private readonly mongo: MongoService,
  ) {}

  /**
   * List incidents with filtering and pagination.
   */
  async listIncidents(filters: ListFilters) {
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

    // Count query
    const countResult = await this.pg.query(
      `SELECT COUNT(*) FROM work_items ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Data query - sorted by severity priority then updated_at
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

    return {
      data: dataResult.rows,
      pagination: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  /**
   * Get a single incident by external_id.
   */
  async getIncidentById(externalId: string) {
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
   * Get internal ID by external_id (for joins).
   */
  async getInternalId(externalId: string): Promise<number | null> {
    const result = await this.pg.query(
      'SELECT id FROM work_items WHERE external_id = $1',
      [externalId],
    );
    return result.rows[0]?.id || null;
  }

  /**
   * Get raw signals from MongoDB for a given incident.
   */
  async getIncidentSignals(externalId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [signals, total] = await Promise.all([
      this.mongo.signalsRaw
        .find({ linked_work_item_id: externalId })
        .sort({ received_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.mongo.signalsRaw.countDocuments({ linked_work_item_id: externalId }),
    ]);

    return {
      data: signals,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get status transition history for an incident.
   */
  async getStatusHistory(externalId: string) {
    const result = await this.pg.query(
      `SELECT sh.id, sh.from_status, sh.to_status, sh.reason, sh.changed_by, sh.changed_at
       FROM status_history sh
       JOIN work_items wi ON wi.id = sh.work_item_id
       WHERE wi.external_id = $1
       ORDER BY sh.changed_at DESC`,
      [externalId],
    );

    return { data: result.rows };
  }
}

