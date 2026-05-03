import { Injectable } from '@nestjs/common';
import { PostgresService } from '../../common/database/postgres.service';
import { RedisService } from '../../common/redis/redis.service';
import { UpdateStatusDto, IncidentStatus } from '../dto/update-status.dto';

/**
 * Workflow Service - State Pattern
 *
 * Manages incident lifecycle transitions with guards:
 *   OPEN → INVESTIGATING
 *   INVESTIGATING → RESOLVED
 *   RESOLVED → CLOSED (requires RCA)
 *   RESOLVED → INVESTIGATING (reopen)
 *   CLOSED → INVESTIGATING (reopen)
 */

// Valid transitions map
const VALID_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  [IncidentStatus.OPEN]: [IncidentStatus.INVESTIGATING],
  [IncidentStatus.INVESTIGATING]: [IncidentStatus.RESOLVED],
  [IncidentStatus.RESOLVED]: [IncidentStatus.CLOSED, IncidentStatus.INVESTIGATING],
  [IncidentStatus.CLOSED]: [IncidentStatus.INVESTIGATING],
};

@Injectable()
export class WorkflowService {
  constructor(
    private readonly pg: PostgresService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Transition an incident to a new status.
   * Enforces state machine rules + RCA guard.
   */
  async transition(externalId: string, dto: UpdateStatusDto) {
    const client = await this.pg.getClient();

    try {
      await client.query('BEGIN');

      // Lock the row for update (prevent concurrent transitions)
      const result = await client.query(
        `SELECT id, status, version, first_signal_at
         FROM work_items
         WHERE external_id = $1
         FOR UPDATE`,
        [externalId],
      );

      if (result.rows.length === 0) {
        throw new Error('Incident not found');
      }

      const incident = result.rows[0];
      const currentStatus = incident.status as IncidentStatus;
      const targetStatus = dto.status;

      // 1. Validate transition is allowed
      const allowedTargets = VALID_TRANSITIONS[currentStatus];
      if (!allowedTargets || !allowedTargets.includes(targetStatus)) {
        throw new Error(
          `Invalid transition: ${currentStatus} → ${targetStatus}. ` +
          `Allowed: ${allowedTargets?.join(', ') || 'none'}`,
        );
      }

      // 2. Guard: RESOLVED → CLOSED requires complete RCA
      if (targetStatus === IncidentStatus.CLOSED) {
        const rcaResult = await client.query(
          `SELECT id, incident_start, incident_end, root_cause_category, fix_applied, prevention_steps
           FROM rca_records
           WHERE work_item_id = $1`,
          [incident.id],
        );

        if (rcaResult.rows.length === 0) {
          throw new Error(
            'RCA is required to close this incident. Submit RCA first via POST /api/incidents/:id/rca',
          );
        }

        const rca = rcaResult.rows[0];
        const missingFields: string[] = [];
        if (!rca.incident_start) missingFields.push('incident_start');
        if (!rca.incident_end) missingFields.push('incident_end');
        if (!rca.root_cause_category) missingFields.push('root_cause_category');
        if (!rca.fix_applied?.trim()) missingFields.push('fix_applied');
        if (!rca.prevention_steps?.trim()) missingFields.push('prevention_steps');

        if (missingFields.length > 0) {
          throw new Error(
            `RCA is incomplete. Missing fields: ${missingFields.join(', ')}`,
          );
        }

        // Calculate MTTR
        const mttrSeconds = Math.floor(
          (new Date(rca.incident_end).getTime() - new Date(incident.first_signal_at).getTime()) / 1000,
        );

        // Update with closed_at and mttr
        await client.query(
          `UPDATE work_items
           SET status = $1, closed_at = NOW(), mttr_seconds = $2,
               version = version + 1, updated_at = NOW()
           WHERE id = $3`,
          [targetStatus, mttrSeconds, incident.id],
        );
      } else {
        // Standard transition
        await client.query(
          `UPDATE work_items
           SET status = $1, version = version + 1, updated_at = NOW()
           WHERE id = $2`,
          [targetStatus, incident.id],
        );
      }

      // 3. Insert status history
      await client.query(
        `INSERT INTO status_history (work_item_id, from_status, to_status, reason, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          incident.id,
          currentStatus,
          targetStatus,
          dto.reason || null,
          dto.changed_by || 'system',
        ],
      );

      await client.query('COMMIT');

      // 4. Update Redis dashboard cache
      await this.updateDashboardCache(externalId, targetStatus);

      // Return updated incident
      const updated = await this.pg.query(
        `SELECT external_id, component_id, service_type, severity, status,
                first_signal_at, last_signal_at, signal_count, closed_at,
                mttr_seconds, created_at, updated_at
         FROM work_items WHERE external_id = $1`,
        [externalId],
      );

      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update Redis hot cache after status change.
   */
  private async updateDashboardCache(
    externalId: string,
    newStatus: IncidentStatus,
  ): Promise<void> {
    try {
      if (newStatus === IncidentStatus.CLOSED) {
        // Remove from active set
        await this.redis.client.zrem('dashboard:active_incidents', externalId);
      }
      // Invalidate cached incident summary
      await this.redis.client.del(`incident:${externalId}`);
    } catch (error) {
      // Non-critical: dashboard will refresh from DB on next poll
      console.error('[Workflow] Redis cache update failed:', error);
    }
  }
}

