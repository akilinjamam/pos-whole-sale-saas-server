# Deployment runbook — pos-wholesale

The API (`pos-whole-sale-server`) and the web client (`pos-whole-sale-client`) deploy separately.
Both are checked on Day 40: the production server build boots against the Atlas replica set, and
the client builds to static files.

## 0. Before the first deploy

| Need                                                                      | Why                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB replica set** (Atlas M10+, or a self-hosted 3-node set)         | Every stock movement, ledger posting and document number is a transaction. A standalone `mongod` refuses them.                                                                                                  |
| **The API in the same cloud region as the database**                      | A counter sale makes ~27 database round trips. Measured on Day 40 from a dev machine 47 ms from Atlas: 1.3 s per sale. In-region (~1 ms): a few tens of ms. **This is the single biggest performance setting.** |
| Node.js 20+ on the API host, `pm2`                                        |                                                                                                                                                                                                                 |
| A domain with TLS (nginx + Let's Encrypt, or the host's load balancer)    | Refresh tokens are `httpOnly; Secure` cookies — they need HTTPS.                                                                                                                                                |
| A backup target off the box (Backblaze B2, S3, Google Drive via `rclone`) | See `docs/BACKUP.md`.                                                                                                                                                                                           |

## 1. API

```bash
git clone <server repo> /srv/pos-wholesale-server && cd /srv/pos-wholesale-server
npm ci
cp .env.example .env   # then fill it in — see the table below
npm run build          # tsc + tsc-alias → dist/
npm run seed           # first deploy only: roles, the OWNER account, default price tiers
npx tsx scripts/index-review.ts --sync   # builds every index, reports any query that would scan
pm2 start dist/index.js --name pos-wholesale-api
pm2 save
curl -s https://api.example.com/api/v1/health   # status ok, replicaSet: true
```

### `.env` in production

| Variable                                   | Production value                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                 | `production` — turns off demo users and stack traces in errors                                                           |
| `PORT`                                     | `5100` (behind nginx)                                                                                                    |
| `MONGODB_URI`                              | the Atlas SRV string, user with `readWrite` on the one database                                                          |
| `MONGODB_DB_NAME`                          | `pos_wholesale`                                                                                                          |
| `APP_TIMEZONE` / `DEFAULT_CURRENCY`        | `Asia/Dhaka` / `BDT`                                                                                                     |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`  | two **different** 48-byte random hex strings: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CORS_ORIGINS`                             | exactly the client's origin, e.g. `https://app.example.com`                                                              |
| `RATE_LIMIT_*`                             | leave the defaults                                                                                                       |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | the owner's real email and a strong password — **change it at first login**                                              |
| `SEED_DEMO_USERS`                          | `false` (ignored in production anyway)                                                                                   |

### nginx (API)

```nginx
server {
  server_name api.example.com;
  location / {
    proxy_pass http://127.0.0.1:5100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # the app trusts one proxy hop
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 10m;   # CSV imports
  }
}
```

## 2. Web client

```bash
cd pos-whole-sale-client
npm ci
VITE_API_URL=https://api.example.com npm run build   # no /api/v1 — the client adds it
# copy dist/ to the web root
```

```nginx
server {
  server_name app.example.com;
  root /var/www/pos-wholesale;
  location / { try_files $uri /index.html; }        # client-side routes
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
}
```

## 3. Every later deploy

```bash
cd /srv/pos-wholesale-server
scripts/backup.sh                         # a backup before every deploy, not just nightly
git pull && npm ci && npm run build
npm run seed                              # safe to re-run: adds new permissions to roles, never overwrites a password
npx tsx scripts/index-review.ts --sync    # new indexes before traffic needs them
pm2 restart pos-wholesale-api
npx tsx scripts/reconcile-all.ts          # zero drift, or stop and look
```

Then build and copy the client. The client and server share `src/shared/` — **deploy them
together** when `npm run check:shared` changed anything.

## 4. Rolling back

The database is forward-only — there are no migrations to undo, and new fields have defaults — so
rolling back is the previous build: `git checkout <previous tag> && npm ci && npm run build &&
pm2 restart pos-wholesale-api`. If data itself is wrong, restore the pre-deploy backup into a
scratch database first (`scripts/restore-drill.sh`), compare, and only then decide.

## 5. Health and monitoring

- `GET /api/v1/health` — 200 with `db.state: connected` and `replicaSet: true`. Point an uptime
  monitor at it.
- `npx tsx scripts/reconcile-all.ts` nightly from cron after the backup; it exits 1 on any drift.
- `pm2 logs pos-wholesale-api` — JSON lines (pino). `LOG_LEVEL=info`.
- The index review after any release that adds a list screen or a filter.

## 6. Known housekeeping

- The audit log's original `{ orgId, at }` index was superseded on Day 40 by `{ orgId, at, _id }`.
  `scripts/index-review.ts` lists it as _extra_; drop it once:
  `db.audit_logs.dropIndex('orgId_1_at_-1')`.
