import { PoolClient } from 'pg';
import { IncidentStatus } from '../../dto/update-status.dto';
import { WorkItemRepository } from '@/repositories';

/**
 * TransitionContext — everything a state's transition handler might need.
 */
export interface TransitionContext {
  client: PoolClient;
  incident: {
    id: number;
    status: string;
    severity: string;
    version: number;
    first_signal_at: string;
  };
  targetStatus: IncidentStatus;
  reason: string | null;
  changedBy: string;
  workItemRepo: WorkItemRepository;
}

/**
 * IncidentState — State Pattern interface.
 *
 * Each concrete state declares which transitions it permits,
 * optionally runs guards, and executes the DB mutation for
 * that transition. Invalid transitions are structurally
 * impossible because they simply aren't listed.
 */
export interface IncidentState {
  /** The status this state object represents. */
  readonly status: IncidentStatus;

  /** Statuses reachable from this state. */
  readonly allowedTransitions: ReadonlyArray<IncidentStatus>;

  /**
   * Execute the transition.
   * Called only after the target has been confirmed as allowed.
   * Implementations run any guards (e.g. RCA completeness)
   * and perform the DB mutation within the already-open transaction.
   *
   * @throws if a guard fails (e.g. missing RCA)
   */
  execute(ctx: TransitionContext): Promise<void>;
}

