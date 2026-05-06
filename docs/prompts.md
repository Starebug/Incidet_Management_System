# Prompts & Planning Documents

This file documents the prompts, specs, and planning artifacts used to build this Incident Management System.

## Initial Planning Prompts

### 1. System Design & Tech Stack Selection

**Prompt:**
> "Analyze the IMS requirements and recommend the best tech stack. Compare alternatives for backend framework, databases, and queue systems. Justify choices based on the 10k signals/sec requirement and polyglot persistence needs."

**Key Decisions:**
- Backend: NestJS (event-loop fits I/O-heavy ingestion)
- Queue: Redis Streams (simpler than Kafka for this scale, already using Redis)
- Data Lake: MongoDB (flexible schema for raw signals)
- Source of Truth: PostgreSQL (ACID for workflow)
- Hot Cache: Redis (subsecond dashboard reads)

### 2. Protocol & Format Selection

**Prompt:**
> "What protocol and format should be used for signal ingestion to handle 10k/sec? Compare HTTP/JSON vs gRPC/Protobuf."

**Decision:**
- Use HTTP/JSON for simplicity and 1-week timeline
- Backpressure architecture is more critical than protocol optimization
- gRPC noted as future optimization

### 3. Debounce Design

**Prompt:**
> "Design the debounce logic: 100 signals for same component in 10 seconds should create one work item, all linked."

**Solution:**
- Redis key `debounce:{component_id}` with 10s TTL
- SET NX + distributed lock for race condition safety
- All signals linked to work_item_id in MongoDB

### 4. Backpressure Strategy

**Prompt:**
> "The system cannot crash if persistence is slow. Design the backpressure handling."

**Solution:**
- Rate limiting at edge (token bucket)
- Queue buffering (Redis Streams, bounded)
- Bounded concurrency (worker pool)
- Circuit breakers (fail fast)
- Dead letter queue (no data loss)
- Public batch requests can be large, but the server should internally chunk them before enqueue

### 5. Design Patterns

**Prompt:**
> "What design patterns should be used for alerting strategy and workflow state machine?"

**Decision:**
- **Strategy Pattern** for alerting (swap by service type)
- **State Pattern** for workflow (transition guards, RCA validation)

---

## Feature Specifications

### Signal Ingestion Spec

```
POST /api/signals/ingest/batch
Content-Type: application/json

{
  "signals": [
    {
      "signal_id": "uuid",
      "component_id": "CACHE_CLUSTER_01",
      "service_type": "DISTRIBUTED_CACHE",
      "severity": "P2",
      "event_ts": "ISO-8601",
      "payload": { ... }
    }
  ]
}

Response: 202 Accepted (queued)
Response: 429 Too Many Requests (rate limited)
Response: 503 Service Unavailable (queue full)
```

Batch semantics:
- Up to **10,000** signals may be submitted in one request
- Rate limiting is charged **per signal in the batch**
- Accepted requests are internally chunked into **250-signal** slices before bounded concurrent enqueue

### Workflow Transition Rules

```
OPEN → INVESTIGATING      : allowed
INVESTIGATING → RESOLVED  : allowed
RESOLVED → CLOSED         : requires valid RCA
RESOLVED → INVESTIGATING  : allowed (reopen)
CLOSED → INVESTIGATING    : allowed (reopen)

RCA Required Fields:
- incident_start (datetime)
- incident_end (datetime)
- root_cause_category (enum)
- fix_applied (text, non-empty)
- prevention_steps (text, non-empty)

MTTR = incident_end - first_signal_at
```

### Dashboard Requirements

```
Live Feed:
- Show OPEN, INVESTIGATING, RESOLVED incidents
- Sort by: severity (P0 > P1 > P2 > P3), then updated_at DESC
- Refresh every 5 seconds (polling)

Incident Detail:
- Incident metadata
- Status timeline
- Raw signals (paginated from MongoDB)
- RCA form

RCA Form:
- Date-time pickers for start/end
- Category dropdown
- Text areas for fix and prevention
- Validation before submit
```

---

## Architecture Decisions Record (ADR)

### ADR-001: Polyglot Persistence

**Context:** Assignment requires separate storage for raw signals vs structured workflow.

**Decision:** Use MongoDB for raw signals, PostgreSQL for workflow.

**Rationale:**
- MongoDB handles heterogeneous payloads well
- PostgreSQL provides ACID for state transitions
- Clear separation per assignment rubric

### ADR-002: Redis as Control Plane

**Context:** Need debounce, rate limit, hot cache, and queue.

**Decision:** Use Redis for all control plane needs.

**Rationale:**
- Single system for multiple needs (simpler ops)
- Atomic operations for debounce (SET NX EX)
- Redis Streams for queue (good enough for 10k/sec)
- Sorted sets for dashboard hot data
- Token bucket can charge by signal count for batch requests

### ADR-003: Async-First Processing

**Context:** Must not block on slow persistence.

**Decision:** Queue-based async processing.

**Rationale:**
- API returns immediately after enqueue
- Workers handle persistence with retries
- Backpressure via bounded queue

---

## Implementation Checklist

### Day 1: Foundation
- [x] Project scaffolding (backend/frontend/docs)
- [x] Docker Compose for infrastructure
- [x] PostgreSQL schema
- [x] MongoDB indexes
- [x] Redis key design

### Day 2: Ingestion
- [ ] Rate limiter middleware
- [ ] Ingest endpoint
- [ ] Redis Stream producer
- [ ] Signal validation

### Day 3: Processing
- [ ] Stream consumer worker
- [ ] Debounce logic with locks
- [ ] MongoDB raw write
- [ ] PostgreSQL work item creation
- [ ] Signal linking

### Day 4: Workflow
- [ ] State pattern implementation
- [ ] Status transition API
- [ ] RCA submission API
- [ ] MTTR calculation
- [ ] Status history logging

### Day 5: Alerting & Dashboard API
- [ ] Strategy pattern for alerting
- [ ] Live feed API
- [ ] Incident detail API
- [ ] Dashboard cache updates

### Day 6: Frontend
- [ ] React project setup
- [ ] Live feed page
- [ ] Incident detail page
- [ ] RCA form with validation

### Day 7: Polish
- [ ] Health endpoint
- [ ] Throughput metrics logging
- [ ] Unit tests (RCA validation)
- [ ] Load test script
- [ ] Documentation review

---

## Test Scenarios

### Scenario 1: Normal Ingestion
1. Send signal for RDBMS_PRIMARY_01
2. Verify work item created (status OPEN, severity P0)
3. Verify signal stored in MongoDB with link

### Scenario 2: Debounce
1. Send 100 signals for CACHE_CLUSTER_01 in 10s
2. Verify only 1 work item created
3. Verify all 100 signals linked to same work item

### Scenario 3: RCA Validation
1. Create incident, move to RESOLVED
2. Try to close without RCA → fail
3. Submit incomplete RCA → fail
4. Submit complete RCA → success
5. Verify MTTR calculated

### Scenario 4: Backpressure
1. Slow down DB writes artificially
2. Send burst of signals
3. Verify API remains responsive
4. Verify queue buffers signals
5. Verify signals eventually persisted

---

## Load Test Parameters

```javascript
// k6 test configuration
export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: 10000,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<50'],
  },
};
```

