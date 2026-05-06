# Backpressure Handling

## Problem Statement

The IMS must handle bursts of up to **10,000 signals/second** without crashing, even when the persistence layer (MongoDB, PostgreSQL) is slow or temporarily unavailable.

## Solution Overview

We implement a multi-layer backpressure strategy:

1. **Rate Limiting** at the edge (prevent overload)
2. **Queue Buffering** between ingestion and processing (absorb bursts)
3. **Bounded Concurrency** in workers (protect databases)
4. **Circuit Breakers** on downstream calls (fail fast)
5. **Graceful Degradation** when limits are reached

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BACKPRESSURE LAYERS                              │
│                                                                          │
│  Layer 1: RATE LIMITING                                                 │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ Client batch → Rate Limiter → Accept/Reject (429)              │    │
│  │ Strategy: Token bucket, 10k signal-tokens/sec, burst allowance │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                    │                                    │
│                                    ▼                                    │
│  Layer 2: QUEUE BUFFERING                                               │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ API → Redis Stream → Workers                                   │    │
│  │ Max length: 100,000 messages (bounded)                         │    │
│  │ Overflow: Reject new signals (503)                             │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                    │                                    │
│                                    ▼                                    │
│  Layer 3: BOUNDED CONCURRENCY                                           │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ Worker Pool: N concurrent processors                           │    │
│  │ Each worker: M concurrent DB operations                        │    │
│  │ Total: N × M bounded connections                               │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                    │                                    │
│                                    ▼                                    │
│  Layer 4: CIRCUIT BREAKERS                                              │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ DB call → Circuit Breaker → Success/Fail                       │    │
│  │ Open circuit: Skip calls, queue for retry                      │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Layer 1: Rate Limiting

### Implementation

```typescript
// Token bucket rate limiter using Redis
const BUCKET_CAPACITY = 10000; // signals
const REFILL_RATE = 10000;     // signals / second

async function checkRateLimit(clientId: string, signalsInBatch: number): Promise<boolean> {
  // Consume one token per signal in the request body.
  // A 500-signal batch consumes 500 tokens; a 10,000-signal batch consumes the full bucket.
  return tokenBucketConsume(clientId, signalsInBatch, BUCKET_CAPACITY, REFILL_RATE);
}
```

### Behavior

| Scenario | Response |
|----------|----------|
| Under limit | `202 Accepted` |
| Over limit | `429 Too Many Requests` |
| Redis unavailable | Allow through (fail-open for availability) |

Notes:
- The public ingestion API accepts up to **10,000** signals per request.
- The rate limiter charges **per signal**, not per HTTP request.
- Accepted requests are internally split into **250-signal** chunks before enqueueing.
- Inside each 250-signal chunk, enqueueing uses **streaming bounded parallelism** (default concurrency `20`) rather than fixed sub-batch barriers.

### Headers Returned

```
X-RateLimit-Limit: 10000
X-RateLimit-Remaining: 8500
X-RateLimit-Reset: 1714550401
```

## Layer 2: Queue Buffering

### Redis Streams Configuration

```typescript
const STREAM_KEY = 'signals:ingest';
const MAX_STREAM_LENGTH = 100000;
const CONSUMER_GROUP = 'signal-processors';

// Producer: Add with bounded length
await redis.xadd(
  STREAM_KEY,
  'MAXLEN', '~', MAX_STREAM_LENGTH, // Approximate trimming
  '*',
  'signal_id', signalId,
  'payload', JSON.stringify(payload)
);

// Consumer: Read with blocking
await redis.xreadgroup(
  'GROUP', CONSUMER_GROUP, consumerId,
  'COUNT', 100,
  'BLOCK', 1000,
  'STREAMS', STREAM_KEY, '>'
);
```

### Queue Monitoring

```typescript
// Check queue depth
const info = await redis.xinfo('STREAM', STREAM_KEY);
const length = info.length;
const lag = info.groups[0]?.lag || 0;

// Alert if queue backing up
if (length > 50000) {
  logger.warn('Queue depth high', { length, lag });
  metrics.gauge('queue_depth', length);
}
```

### Overflow Handling

When queue reaches max length:
1. Log warning
2. Return `503 Service Unavailable` to client
3. Client should implement exponential backoff retry

## Layer 3: Bounded Concurrency

### Worker Pool Configuration

```typescript
const WORKER_CONCURRENCY = 10;      // Parallel workers
const DB_CONCURRENCY_PER_WORKER = 5; // DB ops per worker
const BATCH_SIZE = 100;              // Signals per batch

// BullMQ worker with concurrency limit
const worker = new Worker('signal-processing', processSignal, {
  concurrency: WORKER_CONCURRENCY,
  limiter: {
    max: DB_CONCURRENCY_PER_WORKER,
    duration: 1000
  }
});
```

### Database Connection Pooling

```typescript
// PostgreSQL pool
const pgPool = new Pool({
  max: 20,                    // Max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  maxUses: 7500              // Recycle connections
});

// MongoDB connection
const mongoClient = new MongoClient(uri, {
  maxPoolSize: 50,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,
  waitQueueTimeoutMS: 5000
});
```

## Layer 4: Circuit Breakers

### Implementation

```typescript
interface CircuitBreakerOptions {
  failureThreshold: number;    // Failures before opening
  resetTimeoutMs: number;      // Time before half-open
  halfOpenRequests: number;    // Test requests in half-open
}

class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailure?: Date;
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        this.state = 'half-open';
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
}
```

### Circuit Configuration

| Service | Failure Threshold | Reset Timeout | Half-Open Requests |
|---------|-------------------|---------------|-------------------|
| PostgreSQL | 5 | 30s | 3 |
| MongoDB | 5 | 30s | 3 |
| Redis | 3 | 10s | 2 |

### Behavior During Open Circuit

1. Skip database calls
2. Queue signals in dead-letter queue
3. Log circuit state change
4. Attempt reset after timeout
5. Process DLQ when circuit closes

## Retry Strategy

### Exponential Backoff

```typescript
const RETRY_OPTIONS = {
  maxAttempts: 5,
  initialDelayMs: 100,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitter: true
};

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let delay = RETRY_OPTIONS.initialDelayMs;
  
  while (attempt < RETRY_OPTIONS.maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt >= RETRY_OPTIONS.maxAttempts) throw error;
      
      const jitter = RETRY_OPTIONS.jitter ? Math.random() * 100 : 0;
      await sleep(Math.min(delay + jitter, RETRY_OPTIONS.maxDelayMs));
      delay *= RETRY_OPTIONS.backoffMultiplier;
    }
  }
}
```

### Retry vs Dead-Letter Decision

| Error Type | Action |
|------------|--------|
| Transient (timeout, connection) | Retry with backoff |
| Client error (validation) | Dead-letter, no retry |
| Server error (500) | Retry up to max attempts |
| Circuit open | Queue for later |

## Dead Letter Queue

### Structure

```typescript
// MongoDB collection: dead_letter_queue
interface DeadLetterEntry {
  _id: ObjectId;
  signal_id: string;
  payload: object;
  error_type: string;
  error_message: string;
  attempt_count: number;
  first_attempt_at: Date;
  last_attempt_at: Date;
  created_at: Date;
}
```

### DLQ Processing

1. Scheduled job checks DLQ every minute
2. Retries older entries (> 5 min old)
3. Alerts if DLQ depth exceeds threshold
4. Manual review for repeatedly failing signals

## Monitoring & Alerting

### Key Metrics

| Metric | Alert Threshold |
|--------|-----------------|
| `queue_depth` | > 50,000 |
| `queue_lag_seconds` | > 30s |
| `rate_limit_rejections_per_min` | > 1000 |
| `circuit_breaker_open` | any |
| `dlq_depth` | > 100 |
| `worker_error_rate` | > 5% |

### Throughput Dashboard

```typescript
// Log throughput every 5 seconds
setInterval(async () => {
  const bucket = Math.floor(Date.now() / 5000);
  const key = `metrics:signals:5s:${bucket - 1}`;
  
  const count = await redis.get(key) || 0;
  const perSecond = count / 5;
  
  console.log({
    timestamp: new Date().toISOString(),
    signals_last_5s: count,
    signals_per_sec: perSecond.toFixed(2),
    queue_depth: await getQueueDepth(),
    dlq_depth: await getDlqDepth()
  });
}, 5000);
```

## Load Test Results Template

| Metric | Target | Achieved | Notes |
|--------|--------|----------|-------|
| Peak RPS | 10,000 | | |
| P95 Latency (ingest) | < 50ms | | |
| Queue Max Depth | 100,000 | | |
| Persistence Catch-up | < 60s | | |
| Memory Peak | < 1GB | | |
| Error Rate | < 1% | | |

## Summary

The backpressure strategy ensures:
1. **No crashes** under burst load (rate limiting + bounded queue)
2. **No data loss** (persistent queue + DLQ)
3. **Graceful degradation** (circuit breakers + retries)
4. **Observability** (metrics + alerting)
5. **Recovery** (auto-drain queue + DLQ processing)

