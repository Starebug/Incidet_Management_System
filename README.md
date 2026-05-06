# Incident Management System (IMS)

A resilient, high-throughput incident management system designed to monitor distributed infrastructure and manage failure mediation workflows.

## Features

- **High-Throughput Ingestion**: Handles bursts of 10,000+ signals/second
- **Smart Debouncing**: Coalesces related signals into single work items
- **Workflow Engine**: State machine for incident lifecycle (OPEN → INVESTIGATING → RESOLVED → CLOSED)
- **Mandatory RCA**: Enforces Root Cause Analysis before incident closure
- **Real-time Dashboard**: Live incident feed with severity sorting
- **Polyglot Persistence**: Optimized storage per use case (MongoDB, PostgreSQL, Redis)

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Signal Sources │────▶│  Ingestion API  │────▶│  Redis Stream   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                              ┌─────────────────────────┼─────────────────────────┐
                              ▼                         ▼                         ▼
                    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
                    │    MongoDB      │     │   PostgreSQL    │     │     Redis       │
                    │   (Data Lake)   │     │ (Source of Truth│     │  (Hot Cache)    │
                    └─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                            ┌─────────────────┐
                                            │  React Frontend │
                                            │   (Dashboard)   │
                                            └─────────────────┘
```

See [docs/architecture.md](./docs/architecture.md) for detailed architecture.

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Backend API | NestJS / FastAPI | REST API + async processing |
| Queue | Redis Streams | Signal buffering, backpressure |
| Data Lake | MongoDB | Raw signal audit storage |
| Source of Truth | PostgreSQL | Transactional workflow state |
| Redis Control Plane | Redis | Rate limiting and debounce coordination |
| Redis Streams Plane | Redis | Ingest and audit streams |
| Redis Cache Plane | Redis | Dashboard projection cache |
| Frontend | React + Vite | Incident dashboard |

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 18+ (for local development)
- pnpm / npm / yarn

### 1. Start Infrastructure Only

```bash
docker compose up -d postgres mongo1 mongo2 mongo3 mongo-init-replica redis-rate-limit-debounce redis-streams redis-dashboard-cache
```

This brings up the shared backend dependencies:
- PostgreSQL (port 5432)
- MongoDB (port 27017)
- Redis control plane (port 6379)
- Redis streams plane (port 6380)
- Redis dashboard cache plane (port 6381)

### 2. Initialize Databases

```bash
# PostgreSQL schema
docker exec -i ims-postgres psql -U ims -d ims_db < backend/sql/001_init_schema.sql

# MongoDB indexes
docker exec -i ims-mongo1 mongosh < backend/mongo/init_indexes.js
```

## Local Deployment

### Option A: Single-process backend

This mode runs the API, signal worker, and audit worker in one Nest process.

```bash
cd backend
npm install
npm run dev
```

Backend API: `http://localhost:3000`

### Option B: Split backend roles locally

Use this mode to run the API, signal worker, and audit worker as separate local processes.

**Terminal 1 — API**

```bash
cd backend
npm run dev:api
```

**Terminal 2 — Signal Worker**

```bash
cd backend
npm run dev:signal-worker
```

**Terminal 3 — Audit Worker**

```bash
cd backend
npm run dev:audit-worker
```

### Verify local deployment

```bash
curl http://localhost:3000/api/health
```

## Docker Deployment

Run the full backend in containers using the split-role services:

```bash
docker compose up -d backend-api backend-signal-worker backend-audit-worker
```

This starts:
- backend API service (`backend-api`)
- signal worker service (`backend-signal-worker`)
- audit worker service (`backend-audit-worker`)

### Scale signal workers in Docker

```bash
docker compose up -d --scale backend-signal-worker=4
```

### Verify Docker deployment

```bash
curl http://localhost:3000/api/health
docker compose logs -f backend-api
```

### 4. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:5173`

## API Endpoints

### Ingestion
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/signals/ingest/batch` | Ingest one or more signals (up to 10,000 per request; internally chunked at 250) |

### Incidents
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/incidents` | List incidents (filterable) |
| GET | `/api/incidents/:id` | Get incident details |
| GET | `/api/incidents/:id/signals` | Get raw signals for incident |
| GET | `/api/incidents/:id/history` | Get status history |
| PATCH | `/api/incidents/:id/status` | Update incident status |
| POST | `/api/incidents/:id/rca` | Submit RCA |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/live` | Live feed data |
| GET | `/api/health` | Health check |

## Backpressure Handling

See [docs/backpressure.md](./docs/backpressure.md) for detailed backpressure strategy.

Key mechanisms:
1. **Rate Limiting**: Token bucket (10k signals/sec per client by default)
2. **Queue Buffering**: Redis Streams (100k max)
3. **Bounded Concurrency**: Worker pool limits
4. **Internal Chunking**: Accepted 10k-signal requests are processed in 250-signal internal slices
5. **Dead Letter Queue**: Capture terminal failures without blocking ingestion

## Implemented Non-Functional Features

The following concrete items are implemented over and above the core CRUD/workflow paths and map directly to the assignment’s scaling, resilience, and bonus-point areas.

### Security / Ingress Protection

- **Strict request validation** using Nest `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, and `transform` enabled.
- **Batch DTO validation** for UUIDs, enums, ISO timestamps, payload objects, and nested batched signals.
- **Public request-size guardrail**: ingestion batches are capped at **10,000** signals per request.
- **Per-client / per-API-key token bucket rate limiting** with standard response headers (`X-RateLimit-*`).
- **Atomic Redis Lua scripts** are used for rate limiting and debounce coordination to avoid race conditions.

### Backpressure, Performance, and Scaling

- **Async ingestion path** uses Redis Streams so the API is decoupled from slower persistence layers.
- **Internal request chunking** splits accepted requests into **250-signal** slices before enqueue fan-out.
- **Streaming bounded enqueue concurrency** and **streaming bounded worker concurrency** keep slots busy without unbounded fan-out.
- **Three-plane Redis topology** isolates contention between:
  - control plane: rate limiting + debounce
  - streams plane: ingest + audit streams and consumer group state
  - cache plane: dashboard projection
- **Dedicated blocking Redis clients** for ingest and audit consumers prevent `XREADGROUP` traffic from blocking normal command-path Redis usage.
- **Role-based backend deployment** using `APP_ROLE=api|signal-worker|audit-worker|all`.
- **Horizontal worker scaling** via Docker Compose, e.g. scaling `backend-signal-worker` replicas independently from the API.

### Resilience and Correctness

- **Idempotent ingest ledger in PostgreSQL** with processing leases to prevent duplicate business-side processing.
- **Separate audit-persistence ledger** so Mongo audit persistence can retry independently from the main incident-processing pipeline.
- **Durable audit scheduling** means business processing completes only after the audit task is safely scheduled, not after Mongo persistence finishes.
- **Consumer-group pending recovery** via `XAUTOCLAIM` for crashed/stalled worker recovery.
- **Dead-letter queue handling** for terminally failed signals and audit persistence failures.
- **Fail-open rate limiter** behavior so Redis control-plane issues do not fully block ingestion.
- **Transactional workflow updates** and guarded state transitions, including mandatory RCA validation before closure.
- **Dashboard cache reconciliation** with Redis-first reads, PostgreSQL fallback, stale-ID pruning, and cache backfill on partial misses.

### Data Layer Separation

- **MongoDB** stores raw high-volume signal/audit payloads.
- **PostgreSQL** stores transactional work items, workflow state, RCA data, and processing ledgers.
- **Redis dashboard cache** serves the hot live-feed path for active incidents.

### Observability and Documentation

- **Health endpoint** at `/api/health` checks Redis, PostgreSQL, and MongoDB reachability.
- **Throughput/failure counters** are emitted from `MetricsService` on a fixed interval.
- **Checked-in markdown artifacts** under `docs/` cover architecture, backpressure, ingestion analysis, prompts, and design notes.

### Concrete Bonus Additions

- **Three separate Redis instances** instead of a single overloaded Redis deployment.
- **Role-split Nest runtime** with independently deployable API, signal worker, and audit worker processes.
- **Cache self-healing** through partial-hit backfill and stale-ID pruning rather than cache-miss fallback only.
- **Independent audit pipeline** that preserves business throughput while still maintaining durable audit persistence guarantees.

## Design Patterns

### Strategy Pattern (Alerting)
Different component types map to different severity levels:
- RDBMS failures → P0
- Cache failures → P2
- Default → P3

### State Pattern (Workflow)
Incident lifecycle with transition guards:
- `RESOLVED → CLOSED` requires valid RCA
- All transitions logged in history

## Sample Data

Load sample outage scenario:
```bash
cd backend
npm run load:sample-data
```

Alternative direct API call:
```bash
curl -X POST http://localhost:3000/api/signals/ingest/batch \
  -H "Content-Type: application/json" \
  -d @sample-data/signals_sample.json
```

Ingestion notes:
- Public batch limit: **10,000 signals per request**
- Internal enqueue chunk size: **250 signals** by default
- Rate limiting charges **1 token per signal**, not 1 token per HTTP request

## Load Testing

Run load test with k6:
```bash
k6 run tests/load/ingest_test.js
```

Target metrics:
- Sustained 10k signals/sec
- P95 latency < 50ms
- No crashes under slow DB

## Project Structure

```
├── backend/
│   ├── src/
│   │   ├── ingestion/      # Signal ingestion module
│   │   ├── incidents/      # Incident CRUD
│   │   ├── workflow/       # State machine
│   │   ├── alerting/       # Strategy pattern
│   │   └── dashboard/      # Live feed API
│   ├── sql/                # PostgreSQL schema
│   ├── mongo/              # MongoDB indexes
│   └── redis/              # Redis key design
├── frontend/
│   ├── src/
│   │   ├── pages/          # Live feed, Detail, RCA form
│   │   └── components/     # Shared components
├── docs/
│   ├── architecture.md
│   └── backpressure.md
├── sample-data/
│   └── signals_sample.json
└── docker-compose.yml
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | API server port |
| `APP_ROLE` | `all` | Process role: `all`, `api`, `signal-worker`, or `audit-worker` |
| `POSTGRES_URL` | `postgresql://...` | PostgreSQL connection |
| `MONGODB_URL` | `mongodb://...` | MongoDB connection |
| `REDIS_CONTROL_HOST` | `localhost` | Redis host for rate limiting + debounce |
| `REDIS_CONTROL_PORT` | `6379` | Redis port for rate limiting + debounce |
| `REDIS_STREAMS_HOST` | `localhost` | Redis host for ingest/audit streams |
| `REDIS_STREAMS_PORT` | `6379` | Redis port for ingest/audit streams |
| `REDIS_DASHBOARD_HOST` | `localhost` | Redis host for dashboard cache |
| `REDIS_DASHBOARD_PORT` | `6379` | Redis port for dashboard cache |
| `RATE_LIMIT_BUCKET_CAPACITY` | 10000 | Token bucket capacity (signals) per client |
| `RATE_LIMIT_REFILL_RATE` | 10000 | Token refill rate (signals/sec) per client |
| `BATCH_ENQUEUE_CHUNK_SIZE` | 250 | Internal request chunk size before bounded enqueue |
| `BATCH_ENQUEUE_CONCURRENCY` | 20 | Parallel enqueue width inside each internal chunk |
| `DEBOUNCE_TTL_SEC` | 10 | Debounce window |

## Testing

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Load tests
npm run test:load
```

## Contributing

1. Fork the repository
2. Create feature branch
3. Add tests
4. Submit PR

## License

MIT


