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
| Hot Cache | Redis | Dashboard state, debounce, rate limit |
| Frontend | React + Vite | Incident dashboard |

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 18+ (for local development)
- pnpm / npm / yarn

### 1. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- PostgreSQL (port 5432)
- MongoDB (port 27017)
- Redis (port 6379)

### 2. Initialize Databases

```bash
# PostgreSQL schema
docker exec -i ims-postgres psql -U ims -d ims_db < backend/sql/001_init_schema.sql

# MongoDB indexes
docker exec -i ims-mongo mongosh < backend/mongo/init_indexes.js
```

### 3. Start Backend

```bash
cd backend
npm install
npm run dev
```

Backend runs at `http://localhost:3000`

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
| POST | `/api/signals/ingest/batch` | Ingest one or more signals |

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
| GET | `/health` | Health check |

## Backpressure Handling

See [docs/backpressure.md](./docs/backpressure.md) for detailed backpressure strategy.

Key mechanisms:
1. **Rate Limiting**: Token bucket (10k req/sec)
2. **Queue Buffering**: Redis Streams (100k max)
3. **Bounded Concurrency**: Worker pool limits
4. **Circuit Breakers**: Fail-fast on DB issues
5. **Dead Letter Queue**: Capture failed signals

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
| `POSTGRES_URL` | `postgresql://...` | PostgreSQL connection |
| `MONGODB_URL` | `mongodb://...` | MongoDB connection |
| `REDIS_URL` | `redis://...` | Redis connection |
| `RATE_LIMIT_RPS` | 10000 | Rate limit per second |
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


