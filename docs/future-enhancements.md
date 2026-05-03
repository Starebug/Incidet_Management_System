# Future Enhancements

## Purpose

This document captures improvements intentionally deferred beyond the current assignment scope.
The current implementation focuses on delivering the required ingestion, debouncing, workflow, RCA validation, dashboard, and core async processing flow. The items below are strong follow-up enhancements for production hardening, scale, and operational maturity.

## Why These Were Deferred

The assignment explicitly emphasizes:
- high-throughput signal ingestion
- debouncing by `component_id`
- transactional work item workflow
- mandatory RCA before close
- async processing
- dashboard and incident detail UI
- rate limiting and health visibility

The following items are valuable, but they are not strictly required to demonstrate the core system behavior and would add substantial implementation complexity relative to the assignment timeline.

## Resilience Improvements

### 1. Retry Policies for Transient Failures
Add a shared resilience layer for:
- MongoDB transient write failures
- PostgreSQL transient transaction/query failures
- Redis transient connectivity failures

Recommended shape:
- bounded retries
- exponential backoff
- jitter
- dependency-specific retry classification

### 2. Circuit Breakers for Downstream Dependencies
Introduce circuit breakers around critical persistence operations so the worker does not continuously hammer flapping dependencies.

Target dependencies:
- PostgreSQL work item writes
- MongoDB raw signal persistence
- selected Redis operations where appropriate

### 3. Dead Letter Queue Hardening
The current DLQ foundation can be extended with:
- explicit retry exhaustion routing
- richer error classification
- attempt counters
- DLQ monitoring / dashboard metrics
- replay tooling for failed messages

### 4. Stronger Idempotent Recovery
Improve partial-failure recovery for cases such as:
- raw signal written to MongoDB but not yet linked to a work item
- work item created in PostgreSQL but dashboard cache not updated
- redelivered messages after partial success

Future enhancement:
- reconcile duplicates by checking whether `linked_work_item_id` is already set before skipping processing completely

### 5. Active Incident Reuse Beyond Debounce TTL
Current debounce logic is focused on the 10-second coalescing requirement.
A future enhancement would reuse an existing non-closed work item for the same `component_id` even after the debounce TTL expires, avoiding multiple active incidents during one long-running outage.

### 6. Stronger Worker Payload Validation
Harden worker-side parsing for malformed or partial stream messages by:
- validating required fields after stream consumption
- classifying terminal payload errors immediately
- routing malformed messages directly to DLQ

### 7. Separate Worker Bootstrap / Runtime
Split the worker into a dedicated runtime entrypoint so API and worker processes can scale and fail independently.

Benefits:
- cleaner process isolation
- safer worker-specific concurrency tuning
- independent deployment and restart behavior

## Scaling Improvements

### 1. Partitioned Stream Routing by `component_id`
A future scaling option is partitioning stream traffic by `component_id` so all signals for the same component are routed through one consumer lane.

Benefits:
- reduced debounce coordination overhead
- natural ordering per component
- easier future evolution toward partitioned event streaming

### 2. Redis Role Separation
Split Redis responsibilities into separate logical or physical instances for:
- queue/stream transport
- cache/dashboard hot path
- rate limiting / debounce keys

This reduces contention between critical ingestion transport and secondary caching behavior.

### 3. Dedicated Notification Delivery Pipeline
Separate notification dispatch from signal processing so alert generation does not slow core work item creation.

## Observability Improvements

### 1. Rich Worker Metrics
Extend runtime metrics with:
- stream depth
- pending message count
- reclaimed pending count
- DLQ depth
- retry counts
- circuit breaker state

### 2. Structured Processing Traces
Add correlation fields such as:
- `signal_id`
- `trace_id`
- `component_id`
- `work_item_external_id`

This would improve debugging and replay analysis.

### 3. Enhanced Health Endpoints
Expand `/health` or add a readiness endpoint to include:
- consumer group lag
- queue backlog thresholds
- worker runtime health
- downstream dependency degradation status

## Notification & Integration Enhancements

### 1. Real Notification Dispatch
The current alerting strategy resolves severity and channels conceptually.
A future enhancement would add actual integrations for:
- Slack
- PagerDuty
- email
- webhook-based on-call tools

### 2. Alert Delivery Audit Trail
Persist notification delivery attempts and outcomes for operational auditability.

## Summary

The current backend is intentionally focused on the assignment’s core deliverables.
The enhancements listed here represent the next phase of production hardening and operational maturity, especially around resilience, scale, and observability.

