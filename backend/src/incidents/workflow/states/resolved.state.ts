import { IncidentState, TransitionContext } from './incident-state.interface';
import { IncidentStatus } from '../../dto/update-status.dto';

/**
 * RESOLVED state — a fix has been applied, pending closure.
 *
 * Allowed transitions:
 *   RESOLVED → CLOSED        (guarded — requires complete RCA)
 *   RESOLVED → INVESTIGATING (reopen)
 *
 * The RCA validation guard lives here, co-located with the only
 * transition that requires it, eliminating scattered if-chains.
 */
export class ResolvedState implements IncidentState {
  readonly status = IncidentStatus.RESOLVED;
  readonly allowedTransitions = [
    IncidentStatus.CLOSED,
    IncidentStatus.INVESTIGATING,
  ] as const;

  async execute(ctx: TransitionContext): Promise<void> {
    if (ctx.targetStatus === IncidentStatus.CLOSED) {
      await this.executeClose(ctx);
    } else {
      // Reopen → INVESTIGATING (no guard)
      await ctx.workItemRepo.updateStatus(ctx.client, ctx.incident.id, ctx.targetStatus);
    }
  }

  // ─── RESOLVED → CLOSED guard ──────────────────────────────────────

  private async executeClose(ctx: TransitionContext): Promise<void> {
    const rca = await ctx.workItemRepo.findRcaByWorkItemId(ctx.incident.id);

    if (!rca) {
      throw new Error(
        'RCA is required to close this incident. Submit RCA first via POST /api/incidents/:id/rca',
      );
    }

    const missingFields: string[] = [];
    if (!rca.incident_start)              missingFields.push('incident_start');
    if (!rca.incident_end)                missingFields.push('incident_end');
    if (!rca.root_cause_category)         missingFields.push('root_cause_category');
    if (!rca.fix_applied?.trim())         missingFields.push('fix_applied');
    if (!rca.prevention_steps?.trim())    missingFields.push('prevention_steps');

    if (missingFields.length > 0) {
      throw new Error(
        `RCA is incomplete. Missing fields: ${missingFields.join(', ')}`,
      );
    }

    // Calculate MTTR (seconds between first signal and incident_end from RCA)
    const mttrSeconds = Math.floor(
      (new Date(rca.incident_end).getTime() -
        new Date(ctx.incident.first_signal_at).getTime()) /
        1000,
    );

    await ctx.workItemRepo.closeWithMttr(
      ctx.client,
      ctx.incident.id,
      ctx.targetStatus,
      mttrSeconds,
    );
  }
}

