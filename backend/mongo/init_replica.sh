#!/bin/sh
set -eu

ROOT_USER="${MONGO_INITDB_ROOT_USERNAME:-ims}"
ROOT_PASS="${MONGO_INITDB_ROOT_PASSWORD:-ims_secret}"
REPLICA_SET="${MONGO_REPLICA_SET_NAME:-rs0}"

mongo_uri() {
  host="$1"
  echo "mongodb://${ROOT_USER}:${ROOT_PASS}@${host}:27017/admin?authSource=admin"
}

echo "[mongo-init] Waiting for MongoDB replica set members to accept connections..."
for host in mongo1 mongo2 mongo3; do
  until mongosh "$(mongo_uri "$host")" --quiet --eval "db.adminCommand({ ping: 1 }).ok" >/dev/null 2>&1; do
    echo "[mongo-init] Waiting for ${host}..."
    sleep 2
  done
  echo "[mongo-init] ${host} is reachable"
done

echo "[mongo-init] Initializing replica set if needed..."
mongosh "$(mongo_uri mongo1)" --quiet <<EOF
try {
  rs.status();
  print('[mongo-init] Replica set already initialized');
} catch (err) {
  rs.initiate({
    _id: '${REPLICA_SET}',
    members: [
      { _id: 0, host: 'mongo1:27017' },
      { _id: 1, host: 'mongo2:27017' },
      { _id: 2, host: 'mongo3:27017' }
    ]
  });
  print('[mongo-init] Replica set initiated');
}
EOF

REPLICA_URI="mongodb://${ROOT_USER}:${ROOT_PASS}@mongo1:27017,mongo2:27017,mongo3:27017/admin?authSource=admin&replicaSet=${REPLICA_SET}"

echo "[mongo-init] Waiting for a writable primary..."
until mongosh "$REPLICA_URI" --quiet --eval "db.hello().isWritablePrimary ? 0 : quit(1)" >/dev/null 2>&1; do
  echo "[mongo-init] Waiting for primary election..."
  sleep 2
done

echo "[mongo-init] Ensuring MongoDB indexes are initialized..."
mongosh "mongodb://${ROOT_USER}:${ROOT_PASS}@mongo1:27017,mongo2:27017,mongo3:27017/ims?authSource=admin&replicaSet=${REPLICA_SET}" --quiet --eval "db = db.getSiblingDB('ims'); if (db.getCollectionInfos({ name: 'signals_raw' }).length === 0) { load('/scripts/init_indexes.js'); } else { print('[mongo-init] MongoDB collections/indexes already initialized'); }"

echo "[mongo-init] Replica set bootstrap complete"

