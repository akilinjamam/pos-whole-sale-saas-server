# Backup runbook — pos-wholesale

Everything the business has — stock, every invoice, every taka owed — is in one MongoDB database.
This runbook keeps three copies of it in two places, and proves every week that they restore.

Tested on Day 40: a real `mongodump` of the database, a restore into a scratch database, and a
reconcile of the restored copy — zero drift.

## What runs

| When                      | What                                                                  | Script                     |
| ------------------------- | --------------------------------------------------------------------- | -------------------------- |
| Nightly, 02:00            | Dump → archive → copy off the box → prune                             | `scripts/backup.sh`        |
| Nightly, after the backup | Reconcile the live database; alert on drift                           | `scripts/reconcile-all.ts` |
| Weekly, Sunday            | Restore last night's archive into a scratch database and reconcile it | `scripts/restore-drill.sh` |
| Before every deploy       | A backup                                                              | `scripts/backup.sh`        |

If the database is on Atlas, also turn on **Atlas Cloud Backup** (continuous, point-in-time). It
is the first line; these archives are the copy that does not depend on the database provider.

## Retention

| Tier                | Kept      | Where                 |
| ------------------- | --------- | --------------------- |
| Daily               | 14 days   | on the box and off it |
| Weekly (Sunday's)   | 8 weeks   | on the box and off it |
| Monthly (the 1st's) | 12 months | on the box and off it |

Change with `KEEP_DAILY`, `KEEP_WEEKLY_DAYS`, `KEEP_MONTHLY_DAYS`.

## Setting it up

```bash
# 1. Tools on the backup host
sudo apt install mongodb-database-tools rclone

# 2. A backup-only database user (Atlas: role "backup", or readAnyDatabase on the one database)

# 3. Off-box storage — e.g. a Backblaze B2 bucket with object lock / versioning on
rclone config          # create a remote named "b2"

# 4. /etc/pos-wholesale-backup.env  (chmod 600, owned by the backup user)
MONGODB_URI=mongodb+srv://backup:...@cluster.mongodb.net/
MONGODB_DB_NAME=pos_wholesale_saas
BACKUP_DIR=/var/backups/pos-wholesale-saas
RCLONE_REMOTE=b2:pos-wholesale-saas-backups

# 5. cron (crontab -e for the backup user)
0 2 * * *  set -a; . /etc/pos-wholesale-backup.env; /srv/pos-wholesale-saas-server/scripts/backup.sh >> /var/log/pos-backup.log 2>&1 || echo "BACKUP FAILED" | mail -s "pos backup failed" owner@example.com
30 2 * * * cd /srv/pos-wholesale-saas-server && set -a && . ./.env && npx tsx scripts/reconcile-all.ts >> /var/log/pos-reconcile.log 2>&1 || echo "DRIFT" | mail -s "pos reconcile found drift" owner@example.com
0 4 * * 0  cd /srv/pos-wholesale-saas-server && scripts/restore-drill.sh "$(ls -t /var/backups/pos-wholesale-saas/daily/*.gz | head -1)" >> /var/log/pos-drill.log 2>&1 || echo "DRILL FAILED" | mail -s "pos restore drill failed" owner@example.com
```

The restore drill needs a MongoDB **replica set** to restore into that is not production — a local
one is enough: `docker compose up -d` in the server folder gives one on port 27019
(`DRILL_URI=mongodb://localhost:27019/?directConnection=true`, the default).

## Restoring for real

1. **Stop writes.** `pm2 stop pos-wholesale-saas-api` — a restore under live traffic mixes old and new.
2. **Restore into a scratch database first** and check it:
   `scripts/restore-drill.sh <archive>` → counts per collection, then reconcile.
3. Only then restore over production:
   ```bash
   mongorestore --uri="$MONGODB_URI" --archive=<archive> --gzip --drop \
     --nsInclude='pos_wholesale_saas.*'
   ```
4. `npx tsx scripts/reconcile-all.ts` against production — zero drift.
5. `pm2 start pos-wholesale-saas-api`. Anything entered after the archive was taken must be re-entered:
   check the last document numbers (Settings → Numbering shows the next one).

## What the scripts check

- `backup.sh` refuses an archive under 1 KB (an empty dump is not a backup), and — with
  `CHECK_URI` set — dry-runs it. It says loudly when there is **no off-box copy**.
- `restore-drill.sh` never restores into the source database name, drops its scratch database
  first, and ends with a reconcile that exits non-zero on drift.

Running against a containerised MongoDB instead of installed tools:
`MONGODUMP="docker exec -i pos-wholesale-saas-mongo mongodump" MONGORESTORE="docker exec -i pos-wholesale-saas-mongo mongorestore"`.
