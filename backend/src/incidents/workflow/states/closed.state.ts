import { IncidentState, TransitionContext } from './incident-state.interface';
import { IncidentStatus } from '../../dto/update-status.dto';

/**
 * CLOSED state — the incident is complete.
 *
 * Allowed transitions:
 *   CLOSED → INVESTIGATING (reopen)
 */
export class ClosedState implements IncidentState {
  readonly status = IncidentStatus.CLOSED;
  readonly allowedTransitions = [IncidentStatus.INVESTIGATING] as const;

  async execute(ctx: TransitionContext): Promise<void> {
    await ctx.workItemRepo.updateStatus(ctx.client, ctx.incident.id, ctx.targetStatus);
  }
}

