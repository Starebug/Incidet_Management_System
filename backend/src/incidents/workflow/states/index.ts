import { IncidentState } from './incident-state.interface';
import { IncidentStatus } from '../../dto/update-status.dto';
import { OpenState } from './open.state';
import { InvestigatingState } from './investigating.state';
import { ResolvedState } from './resolved.state';
import { ClosedState } from './closed.state';

/**
 * StateRegistry — singleton map from IncidentStatus → IncidentState.
 *
 * Call `StateRegistry.get(status)` to obtain the state object
 * for any known status. Throws on unknown status so that
 * invalid states fail fast.
 */
const _map = new Map<IncidentStatus, IncidentState>();
_map.set(IncidentStatus.OPEN,          new OpenState());
_map.set(IncidentStatus.INVESTIGATING, new InvestigatingState());
_map.set(IncidentStatus.RESOLVED,      new ResolvedState());
_map.set(IncidentStatus.CLOSED,        new ClosedState());

const STATE_MAP: ReadonlyMap<IncidentStatus, IncidentState> = _map;

export class StateRegistry {
  static get(status: IncidentStatus): IncidentState {
    const state = STATE_MAP.get(status);
    if (!state) {
      throw new Error(`Unknown incident status: ${status}`);
    }
    return state;
  }
}


