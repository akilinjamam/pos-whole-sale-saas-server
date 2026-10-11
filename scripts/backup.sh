#!/usr/bin/env bash
# Nightly backup (Day 40) — see docs/BACKUP.md. A gzipped mongodump archive of the database,
# checked, copied off the box, and pruned on a daily / weekly / monthly schedule.
#
#   MONGODB_URI=... scripts/backup.sh
#
# Settings (environment, with defaults):
#   MONGODB_URI        required — the production connection string (a read-only backup user)
#   MONGODB_DB_NAME    pos_wholesale
#   BACKUP_DIR         /var/backups/pos-wholesale       local copies
#   RCLONE_REMOTE      (empty = skip)                   off-box target, e.g. b2:pos-wholesale-backups
#   KEEP_DAILY         14                               local and remote daily copies, in days
#   KEEP_WEEKLY_DAYS   56                               Sunday copies, 8 weeks
#   KEEP_MONTHLY_DAYS  365                              1st-of-month copies, a year
#   MONGODUMP          mongodump                        e.g. "docker exec -i pos-wholesale-mongo mongodump"
#   CHECK_URI          (empty = skip)                   a server to dry-run the archive against
#   MONGORESTORE       mongorestore                     used only for that check
set -euo pipefail

: "${MONGODB_URI:?MONGODB_URI is required}"
DB="${MONGODB_DB_NAME:-pos_wholesale}"
DIR="${BACKUP_DIR:-/var/backups/pos-wholesale}"
REMOTE="${RCLONE_REMOTE:-}"
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY_DAYS="${KEEP_WEEKLY_DAYS:-56}"
KEEP_MONTHLY_DAYS="${KEEP_MONTHLY_DAYS:-365}"
MONGODUMP="${MONGODUMP:-mongodump}"
MONGORESTORE="${MONGORESTORE:-mongorestore}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DIR/daily" "$DIR/weekly" "$DIR/monthly"
file="$DIR/daily/${DB}-${stamp}.archive.gz"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

log "dumping $DB"
# The archive goes to stdout, so the same line works with a local mongodump or one in a container.
$MONGODUMP --uri="$MONGODB_URI" --db="$DB" --archive --gzip > "$file"
size=$(stat -c %s "$file")
[ "$size" -gt 1000 ] || { log "archive is only $size bytes — refusing to call that a backup"; exit 1; }

# A quick read-back, when there is a server to check against. It proves the archive parses — not
# that it restores: only the weekly restore drill (scripts/restore-drill.sh) proves that.
if [ -n "${CHECK_URI:-}" ]; then
  log "checking the archive reads back"
  $MONGORESTORE --uri="$CHECK_URI" --archive --gzip --dryRun --quiet < "$file"
fi

# Promote: Sunday's copy is also a weekly; the 1st's also a monthly.
# (if-statements, not `[ … ] && cp`: under `set -e` a false test on the last line of an && list
# would end the script here, before the off-box copy.)
if [ "$(date -u +%u)" = 7 ]; then cp "$file" "$DIR/weekly/"; fi
if [ "$(date -u +%d)" = 01 ]; then cp "$file" "$DIR/monthly/"; fi

if [ -n "$REMOTE" ]; then
  log "copying off the box to $REMOTE"
  for tier in daily weekly monthly; do rclone copy "$DIR/$tier" "$REMOTE/$tier"; done
  rclone delete --min-age "${KEEP_DAILY}d" "$REMOTE/daily"
  rclone delete --min-age "${KEEP_WEEKLY_DAYS}d" "$REMOTE/weekly"
  rclone delete --min-age "${KEEP_MONTHLY_DAYS}d" "$REMOTE/monthly"
else
  log "RCLONE_REMOTE not set — this backup is ON THE SAME BOX ONLY"
fi

find "$DIR/daily" -name '*.archive.gz' -mtime +"$KEEP_DAILY" -delete
find "$DIR/weekly" -name '*.archive.gz' -mtime +"$KEEP_WEEKLY_DAYS" -delete
find "$DIR/monthly" -name '*.archive.gz' -mtime +"$KEEP_MONTHLY_DAYS" -delete

log "done: $file ($(numfmt --to=iec "$size"))"
