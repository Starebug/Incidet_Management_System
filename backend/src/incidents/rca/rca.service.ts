import { Injectable } from '@nestjs/common';
import { PostgresService } from '../../common/database/postgres.service';
import { CreateRcaDto } from '../dto/create-rca.dto';

/**
 * RCA Service
 * Manages Root Cause Analysis submission and validation.
 */
@Injectable()
export class RcaService {
  constructor(private readonly pg: PostgresService) {}

  /**
   * Submit RCA for an incident.
   * Validates incident exists and RCA doesn't already exist.
   * Computes MTTR from first_signal_at to incident_end.
   */
  async submitRca(externalId: string, dto: CreateRcaDto) {
    // Get work item
    const wiResult = await this.pg.query(
      'SELECT id, first_signal_at FROM work_items WHERE external_id = $1',
      [externalId],
    );

    if (wiResult.rows.length === 0) {
      throw new Error('Incident not found');
    }

    const workItem = wiResult.rows[0];

    // Check if RCA already exists
    const existingRca = await this.pg.query(
      'SELECT id FROM rca_records WHERE work_item_id = $1',
      [workItem.id],
    );

    if (existingRca.rows.length > 0) {
      throw new Error('RCA already exists for this incident. Use PUT to update.');
    }

    // Validate dates
    const incidentStart = new Date(dto.incident_start);
    const incidentEnd = new Date(dto.incident_end);

    if (incidentEnd < incidentStart) {
      throw new Error('incident_end must be greater than or equal to incident_start');
    }

    // Calculate MTTR
    const firstSignalAt = new Date(workItem.first_signal_at);
    const mttrSeconds = Math.floor((incidentEnd.getTime() - firstSignalAt.getTime()) / 1000);

    // Insert RCA
    const result = await this.pg.query(
      `INSERT INTO rca_records
         (work_item_id, incident_start, incident_end, root_cause_category,
          fix_applied, prevention_steps, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, incident_start, incident_end, root_cause_category,
                 fix_applied, prevention_steps, created_by, created_at`,
      [
        workItem.id,
        dto.incident_start,
        dto.incident_end,
        dto.root_cause_category,
        dto.fix_applied,
        dto.prevention_steps,
        dto.created_by,
      ],
    );

    // Update MTTR on work item
    await this.pg.query(
      'UPDATE work_items SET mttr_seconds = $1, updated_at = NOW() WHERE id = $2',
      [mttrSeconds, workItem.id],
    );

    return {
      ...result.rows[0],
      mttr_seconds: mttrSeconds,
      incident_external_id: externalId,
    };
  }

  /**
   * Get RCA by incident external_id.
   */
  async getRcaByIncidentId(externalId: string) {
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
}

