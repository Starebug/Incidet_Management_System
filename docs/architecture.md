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
│ Chunk Large │
│ Batches     │
│ (250 each)  │
└─────────────┘
      │
      ▼
┌─────────────┐
│ Enqueue to  │──────▶ Return 202 Accepted
│ Redis Stream│
└─────────────┘
```

**Ingestion contract:**
- Public request limit: up to **10,000** signals per `/api/signals/ingest/batch` request
- Edge rate limiter charges **1 token per signal** in the submitted batch
- Accepted requests are internally chunked into **250-signal** slices before bounded concurrent enqueue

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
| Rate Limiter | Redis control plane (token bucket) | Prevent cascading failures from signal storms by charging per signal, not per request |
| Ingest API | NestJS / FastAPI | Validate and accept incoming signals |
| Buffer Queue | Redis Streams plane | Decouple ingestion from processing |

### Processing Layer

| Component | Technology | Purpose |
|-----------|------------|---------|
| Signal Worker | NestJS worker role + Redis consumer group | Consume and process signals asynchronously in dedicated worker processes |
| Audit Worker | NestJS worker role + Redis consumer group | Persist audit signals asynchronously without blocking the business pipeline |
| Debounce Logic | Redis (SET NX EX) | Coalesce signals into single work items |
| Alert Strategy | Strategy Pattern | Route alerts based on component/severity |

The backend runtime now supports `APP_ROLE=api`, `APP_ROLE=signal-worker`, and `APP_ROLE=audit-worker`, so API and worker processes can be deployed and scaled independently while still sharing the same Redis Streams consumer groups.

### Persistence Layer

| Store | Technology | Use Case |
|-------|------------|----------|
| Data Lake | MongoDB | High-volume raw signal storage (audit) |
| Source of Truth | PostgreSQL | Transactional workflow state, RCA |
| Redis Control Plane | Redis | Rate limiting + debounce coordination |
| Redis Streams Plane | Redis | Ingest + audit stream transport |
| Hot Cache | Redis Cache Plane | Real-time dashboard projection for active incidents |
| Aggregations | TimescaleDB / Postgres | Time-series metrics |

### API Layer

| Endpoint Group | Purpose |
|----------------|---------|
| `/api/signals/ingest/batch` | Signal ingestion |
| `/api/incidents` | Incident CRUD |
| `/api/incidents/:id/status` | Workflow transitions |
| `/api/incidents/:id/rca` | RCA submission |
| `/api/incidents/:id/signals` | Raw signals for incident |
| `/api/dashboard/live` | Dashboard data |
| `/health` | System health check |

## Dashboard Cache Consistency Model

- Redis stores an **active-incident dashboard projection**, not a TTL-driven best-effort fragment cache.
- Active incidents (`OPEN`, `INVESTIGATING`, `RESOLVED`) are kept in Redis **without per-entry TTL**.
- When an incident becomes `CLOSED`, its dashboard projection is **explicitly removed** from Redis.
- Dashboard reads are **Redis-first**, but if Redis is missing summaries, contains wrong-status entries, or is unavailable, the API falls back to PostgreSQL and backfills the Redis projection.
- A lightweight reconciliation path prunes stale Redis IDs and repopulates missing summaries from PostgreSQL on demand.

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

