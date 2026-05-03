import { IncidentState, TransitionContext } from './incident-state.interface';
import { IncidentStatus } from '../../dto/update-status.dto';

/**
 * INVESTIGATING state — the team is actively working on the incident.
 *
 * Allowed transitions:
 *   INVESTIGATING → RESOLVED
 */
export class InvestigatingState implements IncidentState {
  readonly status = IncidentStatus.INVESTIGATING;
  readonly allowedTransitions = [IncidentStatus.RESOLVED] as const;

  async execute(ctx: TransitionContext): Promise<void> {
    await ctx.workItemRepo.updateStatus(ctx.client, ctx.incident.id, ctx.targetStatus);
  }
}

