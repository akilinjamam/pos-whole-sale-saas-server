#!/usr/bin/env bash
# Restore drill (Day 40) — see docs/BACKUP.md. Restores an archive into a SCRATCH database (never
# the live one), then reconciles it: a backup is only proven by restoring it.
#
#   scripts/restore-drill.sh /var/backups/pos-wholesale-saas/daily/pos_wholesale_saas-....archive.gz
#
# Settings:
#   DRILL_URI        mongodb://localhost:27019/?directConnection=true   where to restore (a replica set)
#   SOURCE_DB        pos_wholesale_saas                                      the database inside the archive
#   DRILL_DB         restore_drill                                      the scratch database (dropped first)
#   MONGORESTORE     mongorestore    e.g. "docker exec -i pos-wholesale-saas-mongo mongorestore"
#   MONGOSH          mongosh
set -euo pipefail

file="${1:?usage: restore-drill.sh <archive.gz>}"
URI="${DRILL_URI:-mongodb://localhost:27019/?directConnection=true}"
SRC="${SOURCE_DB:-pos_wholesale_saas}"
DRILL="${DRILL_DB:-restore_drill}"
MONGORESTORE="${MONGORESTORE:-mongorestore}"
MONGOSH="${MONGOSH:-mongosh}"
[ "$DRILL" != "$SRC" ] || { echo "DRILL_DB must not be the source database"; exit 1; }

echo "restoring $file into $DRILL"
$MONGOSH "$URI" --quiet --eval "db.getSiblingDB('$DRILL').dropDatabase()" > /dev/null
$MONGORESTORE --uri="$URI" --archive --gzip --nsFrom="$SRC.*" --nsTo="$DRILL.*" --quiet < "$file"

echo "counting what came back"
$MONGOSH "$URI" --quiet --eval "
  const d = db.getSiblingDB('$DRILL');
  d.getCollectionNames().sort().forEach((c) => print(c.padEnd(28), d.getCollection(c).countDocuments()));
"

echo "reconciling the restored copy"
cd "$(dirname "$0")/.."
MONGODB_URI="$URI" MONGODB_DB_NAME="$DRILL" npx tsx scripts/reconcile-all.ts
