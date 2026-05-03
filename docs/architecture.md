# Architecture Overview

## System Context

The Incident Management System (IMS) monitors a distributed stack (APIs, MCP Hosts, Caches, Queues, RDBMS, NoSQL) and manages failure mediation workflow. It ingests high-volume signals, creates deduplicated work items, and guides incidents through resolution with mandatory Root Cause Analysis.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SIGNAL PRODUCERS                                │
│  (APIs, MCP Hosts, Distributed Caches, Async Queues, RDBMS, NoSQL stores)   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INGESTION LAYER                                    │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │  Rate Limiter   │───▶│  Ingest API     │───▶│  Redis Stream   │         │
│  │  (Redis)        │    │  (NestJS/Fast)  │    │  (Buffer/Queue) │         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PROCESSING LAYER                                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │  Signal Worker  │───▶│  Debounce Logic │───▶│  Alert Strategy │         │
│  │  (Consumer)     │    │  (Redis Keys)   │    │  (P0/P1/P2/P3)  │         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PERSISTENCE LAYER                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │   MongoDB     │  │  PostgreSQL   │  │    Redis      │  │ TimescaleDB  │ │
│  │   (Data Lake) │  │   (Source of  │  │   (Hot Path   │  │ (Aggregates) │ │
│  │   Raw Signals │  │    Truth)     │  │    Cache)     │  │              │ │
│  └───────────────┘  └───────────────┘  └───────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API LAYER                                       │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │  Incident API   │    │  Workflow API   │    │  Dashboard API  │         │
│  │  (CRUD + RCA)   │    │  (State Machine)│    │  (Live Feed)    │         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │  Live Feed      │    │  Incident Detail│    │  RCA Form       │         │
│  │  (React)        │    │  + Signals View │    │  + Validation   │         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Signal Ingestion Flow

```
Signal Received
      │
      ▼
┌─────────────┐     NO      ┌─────────────┐
│ Rate Limit  │────────────▶│ 429 Response│
│ Check       │             └─────────────┘
└─────────────┘
      │ YES (under limit)
      ▼
┌─────────────┐
│ Validate    │
│ Payload     │
└─────────────┘
      │
      ▼
┌─────────────┐
│ Enqueue to  │──────▶ Return 202 Accepted
│ Redis Stream│
└─────────────┘
```

### 2. Signal Processing Flow (Async Worker)

```
Consume from Stream
      │
      ▼
┌─────────────────┐
│ Write Raw Signal│
│ to MongoDB      │
└─────────────────┘
      │
      ▼
┌─────────────────┐     EXISTS     ┌─────────────────┐
│ Check Debounce  │───────────────▶│ Link Signal to  │
│ Key in Redis    │                │ Existing WI     │
└─────────────────┘                └─────────────────┘
      │ NOT EXISTS
      ▼
┌─────────────────┐
│ Acquire Lock    │
│ (Redis)         │
└─────────────────┘
      │
      ▼
┌─────────────────┐     EXISTS     ┌─────────────────┐
│ Double-Check    │───────────────▶│ Link Signal to  │
│ Debounce Key    │                │ Existing WI     │
└─────────────────┘                └─────────────────┘
      │ NOT EXISTS
      ▼
┌─────────────────┐
│ Create Work Item│
│ in PostgreSQL   │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ Set Debounce Key│
│ TTL = 10 sec    │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ Determine Alert │
│ (Strategy)      │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ Update Dashboard│
│ Cache (Redis)   │
└─────────────────┘
```

### 3. Workflow State Machine

```
                    ┌───────────────────────────────────────┐
                    │                                       │
                    ▼                                       │
              ┌──────────┐                                  │
  ──────────▶ │   OPEN   │                                  │
   (create)   └──────────┘                                  │
                    │                                       │
                    │ assign / start investigation          │
                    ▼                                       │
            ┌───────────────┐                               │
            │ INVESTIGATING │ ◀────────────────────────────┐│
            └───────────────┘                              ││
                    │                                      ││
                    │ mark resolved                        ││
                    ▼                                      ││
              ┌──────────┐                                 ││
              │ RESOLVED │─────────────────────────────────┘│
              └──────────┘     reopen (needs more work)     │
                    │                                       │
                    │ close (requires valid RCA)            │
                    ▼                                       │
              ┌──────────┐                                  │
              │  CLOSED  │──────────────────────────────────┘
              └──────────┘     reopen (new signals / wrong RCA)
```

**Transition Rules:**
- `OPEN → INVESTIGATING`: User assigns/starts
- `INVESTIGATING → RESOLVED`: Issue fixed, pending RCA
- `RESOLVED → CLOSED`: **Requires complete RCA**
- `RESOLVED → INVESTIGATING`: Reopen if issue persists
- `CLOSED → INVESTIGATING`: Reopen if new signals arrive

## Component Descriptions

### Ingestion Layer

| Component | Technology | Purpose |
|-----------|------------|---------|
| Rate Limiter | Redis (token bucket) | Prevent cascading failures from signal storms |
| Ingest API | NestJS / FastAPI | Validate and accept incoming signals |
| Buffer Queue | Redis Streams | Decouple ingestion from processing |

### Processing Layer

| Component | Technology | Purpose |
|-----------|------------|---------|
| Signal Worker | BullMQ / asyncio | Consume and process signals asynchronously |
| Debounce Logic | Redis (SET NX EX) | Coalesce signals into single work items |
| Alert Strategy | Strategy Pattern | Route alerts based on component/severity |

### Persistence Layer

| Store | Technology | Use Case |
|-------|------------|----------|
| Data Lake | MongoDB | High-volume raw signal storage (audit) |
| Source of Truth | PostgreSQL | Transactional workflow state, RCA |
| Hot Cache | Redis | Real-time dashboard, counters |
| Aggregations | TimescaleDB / Postgres | Time-series metrics |

### API Layer

| Endpoint Group | Purpose |
|----------------|---------|
| `/api/signals/ingest` | Signal ingestion |
| `/api/incidents` | Incident CRUD |
| `/api/incidents/:id/status` | Workflow transitions |
| `/api/incidents/:id/rca` | RCA submission |
| `/api/incidents/:id/signals` | Raw signals for incident |
| `/api/dashboard/live` | Dashboard data |
| `/health` | System health check |

## Design Patterns

### Strategy Pattern (Alerting)

```
┌─────────────────────────────────────────────────────────┐
│                  AlertStrategyResolver                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │  resolveStrategy(serviceType, componentId)      │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │ RdbmsP0    │  │ CacheP2    │  │ DefaultP3  │
   │ Strategy   │  │ Strategy   │  │ Strategy   │
   └────────────┘  └────────────┘  └────────────┘
```

### State Pattern (Workflow)

```
┌─────────────────────────────────────────────────────────┐
│                    WorkItemStateMachine                  │
│  ┌─────────────────────────────────────────────────┐   │
│  │  transition(workItem, targetState, context)     │   │
│  │  validateTransition(from, to, context)          │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
     ┌────────────┬───────┴───────┬────────────┐
     ▼            ▼               ▼            ▼
┌─────────┐ ┌─────────────┐ ┌──────────┐ ┌────────┐
│OpenState│ │Investigating│ │Resolved  │ │Closed  │
│         │ │    State    │ │  State   │ │ State  │
└─────────┘ └─────────────┘ └──────────┘ └────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │ canTransitionTo(CLOSED)?  │
                    │ → Validate RCA exists     │
                    │ → Validate RCA complete   │
                    │ → Compute MTTR            │
                    └───────────────────────────┘
```

## Scalability Considerations

1. **Horizontal Scaling**: API and worker instances can be scaled independently
2. **Queue Partitioning**: Redis Streams can use consumer groups for parallel processing
3. **Read Replicas**: PostgreSQL read replicas for dashboard queries
4. **Sharding**: MongoDB can be sharded by `component_id` for write distribution
5. **Cache Layers**: Redis reduces load on PostgreSQL for hot data

## Security Considerations

1. **API Authentication**: Token-based auth on all endpoints
2. **Rate Limiting**: Per-client/API-key limits
3. **Input Validation**: Strict schema validation on ingestion
4. **Audit Trail**: All state changes logged in `status_history`

