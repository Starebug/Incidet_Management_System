// ============================================================
// Incident Management System (IMS) - MongoDB Indexes & Schema Validation
// Data Lake: Raw signal storage + audit log
// ============================================================

// Run with: mongosh < init_indexes.js
// Or: mongosh --eval "load('init_indexes.js')"

// Switch to IMS database
db = db.getSiblingDB('ims');

// ============================================================
// COLLECTION: signals_raw
// High-volume raw signal storage (audit log / data lake)
// ============================================================

// Create collection with schema validation
db.createCollection('signals_raw', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['signal_id', 'component_id', 'service_type', 'severity', 'event_ts', 'received_at', 'payload'],
      properties: {
        signal_id: {
          bsonType: 'string',
          description: 'Unique signal identifier (UUID)'
        },
        component_id: {
          bsonType: 'string',
          description: 'Component that generated the signal (e.g., CACHE_CLUSTER_01)'
        },
        service_type: {
          enum: ['API', 'MCP_HOST', 'DISTRIBUTED_CACHE', 'ASYNC_QUEUE', 'RDBMS', 'NOSQL'],
          description: 'Type of service that generated the signal'
        },
        severity: {
          enum: ['P0', 'P1', 'P2', 'P3'],
          description: 'Signal severity level'
        },
        event_ts: {
          bsonType: 'date',
          description: 'When the event occurred at source'
        },
        received_at: {
          bsonType: 'date',
          description: 'When IMS received the signal'
        },
        payload: {
          bsonType: 'object',
          description: 'Raw signal payload (flexible schema)'
        },
        linked_work_item_id: {
          bsonType: ['string', 'null'],
          description: 'UUID of linked work item in PostgreSQL'
        },
        ingest_meta: {
          bsonType: 'object',
          properties: {
            producer: { bsonType: 'string' },
            schema_version: { bsonType: 'int' },
            api_key_hash: { bsonType: 'string' }
          }
        }
      }
    }
  },
  validationLevel: 'moderate',
  validationAction: 'warn'
});

print('Created signals_raw collection with schema validation');

// ============================================================
// INDEXES: signals_raw
// ============================================================

// Unique index on signal_id (idempotency)
db.signals_raw.createIndex(
  { signal_id: 1 },
  { unique: true, name: 'idx_signal_id_unique' }
);

// Primary query: get all signals for an incident
db.signals_raw.createIndex(
  { linked_work_item_id: 1, received_at: -1 },
  { name: 'idx_work_item_signals' }
);

// Component-based queries (debugging, analytics)
db.signals_raw.createIndex(
  { component_id: 1, received_at: -1 },
  { name: 'idx_component_timeline' }
);

// Service type + time range queries
db.signals_raw.createIndex(
  { service_type: 1, received_at: -1 },
  { name: 'idx_service_type_timeline' }
);

// Severity-based queries (e.g., "all P0 signals in last hour")
db.signals_raw.createIndex(
  { severity: 1, received_at: -1 },
  { name: 'idx_severity_timeline' }
);

// Compound index for dashboard drill-down
db.signals_raw.createIndex(
  { component_id: 1, service_type: 1, severity: 1, received_at: -1 },
  { name: 'idx_compound_drill_down' }
);

// TTL index (optional): auto-delete signals older than 90 days
// Uncomment if retention policy needed:
// db.signals_raw.createIndex(
//   { received_at: 1 },
//   { expireAfterSeconds: 7776000, name: 'idx_ttl_90_days' }
// );

print('Created indexes on signals_raw');

// ============================================================
// COLLECTION: signals_aggregations
// Pre-computed aggregations for dashboard (optional)
// ============================================================

db.createCollection('signals_aggregations');

db.signals_aggregations.createIndex(
  { bucket_start: -1, component_id: 1, service_type: 1 },
  { unique: true, name: 'idx_agg_bucket_unique' }
);

print('Created signals_aggregations collection');

// ============================================================
// COLLECTION: dead_letter_queue
// Failed signal processing for retry/investigation
// ============================================================

db.createCollection('dead_letter_queue');

db.dead_letter_queue.createIndex(
  { created_at: 1 },
  { expireAfterSeconds: 604800, name: 'idx_dlq_ttl_7_days' } // 7 day TTL
);

db.dead_letter_queue.createIndex(
  { error_type: 1, created_at: -1 },
  { name: 'idx_dlq_error_type' }
);

print('Created dead_letter_queue collection');

// ============================================================
// SAMPLE QUERIES (for reference)
// ============================================================

print(`
// ============================================================
// SAMPLE QUERIES
// ============================================================

// Get all signals for an incident (paginated)
db.signals_raw.find({ linked_work_item_id: '<uuid>' })
  .sort({ received_at: -1 })
  .skip(0)
  .limit(50);

// Get signals for a component in time range
db.signals_raw.find({
  component_id: 'CACHE_CLUSTER_01',
  received_at: {
    $gte: ISODate('2026-05-01T00:00:00Z'),
    $lt: ISODate('2026-05-02T00:00:00Z')
  }
}).sort({ received_at: -1 });

// Count signals by severity in last hour
db.signals_raw.aggregate([
  {
    $match: {
      received_at: { $gte: new Date(Date.now() - 3600000) }
    }
  },
  {
    $group: {
      _id: '$severity',
      count: { $sum: 1 }
    }
  }
]);

// Signals per minute aggregation
db.signals_raw.aggregate([
  {
    $match: {
      received_at: { $gte: new Date(Date.now() - 3600000) }
    }
  },
  {
    $group: {
      _id: {
        minute: { $dateTrunc: { date: '$received_at', unit: 'minute' } },
        component_id: '$component_id'
      },
      count: { $sum: 1 }
    }
  },
  { $sort: { '_id.minute': -1 } }
]);
`);

print('MongoDB initialization complete!');

