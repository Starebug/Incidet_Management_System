# Design Patterns

This document explains the design patterns used in the IMS and why they were chosen.

## 1. Strategy Pattern (Alerting)

### Problem

Different infrastructure components require different alert severity levels:
- RDBMS failure = Critical (P0) - immediate page
- Cache failure = Medium (P2) - ticket creation
- Unknown component = Low (P3) - log and monitor

Without a pattern, this leads to:
```typescript
// Anti-pattern: scattered if/else
function determineAlertLevel(signal: Signal): string {
  if (signal.serviceType === 'RDBMS') {
    return 'P0';
  } else if (signal.serviceType === 'CACHE') {
    return 'P2';
  } else if (signal.serviceType === 'API' && signal.errorCode === 'TIMEOUT') {
    return 'P1';
  }
  // ... more conditions scattered everywhere
}
```

### Solution: Strategy Pattern

```typescript
// Strategy interface
interface AlertStrategy {
  determineSeverity(signal: Signal): SeverityLevel;
  getNotificationChannels(): string[];
  shouldPage(): boolean;
}

// Concrete strategies
class RdbmsAlertStrategy implements AlertStrategy {
  determineSeverity(signal: Signal): SeverityLevel {
    return 'P0'; // Always critical
  }
  
  getNotificationChannels(): string[] {
    return ['pagerduty', 'slack-critical', 'email-oncall'];
  }
  
  shouldPage(): boolean {
    return true;
  }
}

class CacheAlertStrategy implements AlertStrategy {
  determineSeverity(signal: Signal): SeverityLevel {
    // Cache can degrade gracefully
    return signal.payload.missRate > 50 ? 'P1' : 'P2';
  }
  
  getNotificationChannels(): string[] {
    return ['slack-infra', 'email-team'];
  }
  
  shouldPage(): boolean {
    return false;
  }
}

class DefaultAlertStrategy implements AlertStrategy {
  determineSeverity(signal: Signal): SeverityLevel {
    return 'P3';
  }
  
  getNotificationChannels(): string[] {
    return ['slack-monitoring'];
  }
  
  shouldPage(): boolean {
    return false;
  }
}

// Strategy resolver (Factory)
class AlertStrategyResolver {
  private strategies: Map<string, AlertStrategy> = new Map([
    ['RDBMS', new RdbmsAlertStrategy()],
    ['DISTRIBUTED_CACHE', new CacheAlertStrategy()],
    ['ASYNC_QUEUE', new QueueAlertStrategy()],
    ['API', new ApiAlertStrategy()],
    ['MCP_HOST', new McpAlertStrategy()],
  ]);
  
  resolve(serviceType: string): AlertStrategy {
    return this.strategies.get(serviceType) || new DefaultAlertStrategy();
  }
}

// Usage
const resolver = new AlertStrategyResolver();
const strategy = resolver.resolve(signal.serviceType);
const severity = strategy.determineSeverity(signal);
const channels = strategy.getNotificationChannels();
```

### Benefits

1. **Open/Closed Principle**: Add new strategies without modifying existing code
2. **Single Responsibility**: Each strategy handles one component type
3. **Testability**: Test each strategy in isolation
4. **Configuration**: Strategies can be loaded from config/DB

---

## 2. State Pattern (Workflow)

### Problem

Incident lifecycle has states and transition rules:
- Can't go OPEN → CLOSED directly
- Can't close without RCA
- Need to log every transition

Without a pattern:
```typescript
// Anti-pattern: complex conditionals
function updateStatus(incident: WorkItem, newStatus: Status): void {
  if (incident.status === 'OPEN' && newStatus === 'CLOSED') {
    throw new Error('Cannot close directly from OPEN');
  }
  if (newStatus === 'CLOSED') {
    const rca = await getRcaForIncident(incident.id);
    if (!rca || !rca.isComplete()) {
      throw new Error('RCA required');
    }
  }
  // ... more scattered rules
}
```

### Solution: State Pattern

```typescript
// State interface
interface IncidentState {
  readonly name: IncidentStatus;
  
  canTransitionTo(targetState: IncidentStatus): boolean;
  getAllowedTransitions(): IncidentStatus[];
  
  onEnter(incident: WorkItem, context: TransitionContext): Promise<void>;
  onExit(incident: WorkItem, context: TransitionContext): Promise<void>;
  
  validate(incident: WorkItem, context: TransitionContext): ValidationResult;
}

// Concrete states
class OpenState implements IncidentState {
  readonly name = 'OPEN';
  
  canTransitionTo(target: IncidentStatus): boolean {
    return target === 'INVESTIGATING';
  }
  
  getAllowedTransitions(): IncidentStatus[] {
    return ['INVESTIGATING'];
  }
  
  async onEnter(incident: WorkItem, context: TransitionContext): Promise<void> {
    // Initial state - nothing special
  }
  
  async onExit(incident: WorkItem, context: TransitionContext): Promise<void> {
    // Log the assignment
  }
  
  validate(): ValidationResult {
    return { valid: true };
  }
}

class ResolvedState implements IncidentState {
  readonly name = 'RESOLVED';
  
  canTransitionTo(target: IncidentStatus): boolean {
    return ['INVESTIGATING', 'CLOSED'].includes(target);
  }
  
  getAllowedTransitions(): IncidentStatus[] {
    return ['INVESTIGATING', 'CLOSED'];
  }
  
  async onEnter(incident: WorkItem, context: TransitionContext): Promise<void> {
    // Mark resolution time
  }
  
  async onExit(incident: WorkItem, context: TransitionContext): Promise<void> {
    // Nothing special
  }
  
  validate(incident: WorkItem, context: TransitionContext): ValidationResult {
    // If transitioning to CLOSED, require RCA
    if (context.targetState === 'CLOSED') {
      return this.validateRcaForClose(incident);
    }
    return { valid: true };
  }
  
  private validateRcaForClose(incident: WorkItem): ValidationResult {
    const rca = context.rca;
    
    if (!rca) {
      return { valid: false, error: 'RCA is required to close incident' };
    }
    
    const requiredFields = ['incident_start', 'incident_end', 'root_cause_category', 'fix_applied', 'prevention_steps'];
    const missingFields = requiredFields.filter(f => !rca[f]);
    
    if (missingFields.length > 0) {
      return { 
        valid: false, 
        error: `RCA missing required fields: ${missingFields.join(', ')}` 
      };
    }
    
    return { valid: true };
  }
}

class ClosedState implements IncidentState {
  readonly name = 'CLOSED';
  
  canTransitionTo(target: IncidentStatus): boolean {
    return target === 'INVESTIGATING'; // Allow reopen
  }
  
  async onEnter(incident: WorkItem, context: TransitionContext): Promise<void> {
    // Calculate and store MTTR
    incident.closed_at = new Date();
    incident.mttr_seconds = calculateMttr(incident, context.rca);
  }
  
  // ...
}

// State Machine
class WorkItemStateMachine {
  private states: Map<IncidentStatus, IncidentState> = new Map([
    ['OPEN', new OpenState()],
    ['INVESTIGATING', new InvestigatingState()],
    ['RESOLVED', new ResolvedState()],
    ['CLOSED', new ClosedState()],
  ]);
  
  async transition(
    incident: WorkItem, 
    targetStatus: IncidentStatus,
    context: TransitionContext
  ): Promise<WorkItem> {
    const currentState = this.states.get(incident.status);
    const targetState = this.states.get(targetStatus);
    
    // Check if transition allowed
    if (!currentState.canTransitionTo(targetStatus)) {
      throw new InvalidTransitionError(
        `Cannot transition from ${incident.status} to ${targetStatus}`
      );
    }
    
    // Validate transition
    const validation = currentState.validate(incident, { ...context, targetState: targetStatus });
    if (!validation.valid) {
      throw new ValidationError(validation.error);
    }
    
    // Execute transition
    await currentState.onExit(incident, context);
    incident.status = targetStatus;
    await targetState.onEnter(incident, context);
    
    // Log history
    await this.logTransition(incident, currentState.name, targetStatus, context);
    
    return incident;
  }
}
```

### Benefits

1. **Encapsulation**: Each state knows its own rules
2. **Maintainability**: Add new states without changing others
3. **Audit Trail**: Centralized transition logging
4. **Validation**: Guards prevent invalid transitions
5. **Side Effects**: onEnter/onExit handle state-specific logic (MTTR calculation)

---

## 3. Producer-Consumer Pattern (Async Processing)

### Problem

Ingestion must be fast; persistence can be slow. Direct coupling causes:
- Timeout under load
- Cascading failures
- No backpressure

### Solution

```
Producer (API) → Queue (Redis Streams) → Consumer (Worker)
```

```typescript
// Producer (in API handler)
async function ingestSignal(signal: SignalDto): Promise<void> {
  // Fast path: validate and enqueue
  validateSignal(signal);
  
  await redis.xadd(
    'signals:ingest',
    '*',
    'payload', JSON.stringify(signal)
  );
  
  // Return immediately - don't wait for DB
}

// Consumer (worker process)
async function processSignals(): Promise<void> {
  while (true) {
    const messages = await redis.xreadgroup(
      'GROUP', 'processors', workerId,
      'COUNT', 100,
      'BLOCK', 1000,
      'STREAMS', 'signals:ingest', '>'
    );
    
    for (const message of messages) {
      try {
        await processSignal(message);
        await redis.xack('signals:ingest', 'processors', message.id);
      } catch (error) {
        // Will be redelivered or go to pending
        logger.error('Failed to process signal', error);
      }
    }
  }
}
```

---

## 4. Circuit Breaker Pattern (Resilience)

### Problem

When database is down, continuous retries:
- Waste resources
- Delay recovery
- Cascade failures

### Solution

```typescript
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime?: number;
  
  private readonly threshold = 5;
  private readonly resetTimeout = 30000; // 30 sec
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime! > this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitOpenError();
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
    }
  }
}

// Usage
const dbCircuit = new CircuitBreaker();

async function saveToDb(data: any): Promise<void> {
  return dbCircuit.call(() => db.insert(data));
}
```

---

## Summary

| Pattern | Purpose | Location |
|---------|---------|----------|
| **Strategy** | Swap alerting logic by component type | `alerting/strategies/` |
| **State** | Manage workflow transitions + guards | `workflow/states/` |
| **Producer-Consumer** | Decouple ingestion from persistence | `ingestion/` + `workers/` |
| **Circuit Breaker** | Fail fast on downstream failures | `common/resilience/` |
| **Repository** | Abstract data access | `repositories/` |
| **Factory** | Create strategy/state instances | `factories/` |

