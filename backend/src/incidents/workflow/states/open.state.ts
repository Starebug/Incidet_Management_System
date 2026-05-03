import { IncidentState, TransitionContext } from './incident-state.interface';
import { IncidentStatus } from '../../dto/update-status.dto';

/**
 * OPEN state — the initial state for every new incident.
 *
 * Allowed transitions:
 *   OPEN → INVESTIGATING
 */
export class OpenState implements IncidentState {
  readonly status = IncidentStatus.OPEN;
  readonly allowedTransitions = [IncidentStatus.INVESTIGATING] as const;

  async execute(ctx: TransitionContext): Promise<void> {
    await ctx.workItemRepo.updateStatus(ctx.client, ctx.incident.id, ctx.targetStatus);
  }
}

