/**
 * The daily subscription job (SaaS phase 6): mark lapsed businesses past due, send the 7 / 3 / 1-day
 * reminders, the "payment due" and "now read-only" emails, and the weekly summary to platform admins.
 * The work is in `src/services/subscriptionLifecycle.service.ts`.
 *
 *   npm run job:subscriptions                  # for real
 *   npm run job:subscriptions -- --now 2026-11-01T03:00:00Z   # pretend it is that moment (testing)
 *
 * Safe to run more than once a day — every email goes out once. Schedule it once a day in the
 * morning (Dhaka) with pm2 or cron; see docs/DEPLOY.md. Exit 1 if any email failed to send (they are
 * retried on the next run), so a monitor watching the exit code notices a broken SMTP setup.
 */
import { parseArgs } from 'node:util';

import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import { runSubscriptionLifecycle } from '../src/services/subscriptionLifecycle.service.js';

const { values } = parseArgs({ options: { now: { type: 'string' } } });
const now = values.now ? new Date(values.now) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`--now is not a date: ${values.now}`);
  process.exit(2);
}

await connectDatabase();
try {
  const summary = await runSubscriptionLifecycle(now);
  logger.info({ ...summary, now: now.toISOString() }, 'Subscription job finished');
  console.log(JSON.stringify({ now: now.toISOString(), ...summary }, null, 2));
  if (summary.emailsFailed > 0 || summary.weeklySummary === 'failed') process.exitCode = 1;
} catch (err) {
  logger.error({ err }, 'Subscription job failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
