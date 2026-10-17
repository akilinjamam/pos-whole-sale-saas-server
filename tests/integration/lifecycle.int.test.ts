import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { Org } from '../../src/modules/org/org.model.js';
import { SubscriptionNotice } from '../../src/modules/platform/subscriptionNotice.model.js';
import { outbox } from '../../src/services/mailer.service.js';
import { provisionOrg } from '../../src/services/provisioning.service.js';
import {
  runSubscriptionLifecycle,
  weekStartOf,
} from '../../src/services/subscriptionLifecycle.service.js';

import { cleanupOrg } from './fixtures/posFixture.js';

import type { ProvisionedOrg } from '../../src/services/provisioning.service.js';

/**
 * SaaS phase 6's "done when": a business whose trial ends tomorrow gets the email, and the next day
 * becomes past due without anyone acting. Runs the job in-process with a chosen `now`, scoped to
 * this test's business so the rest of the database is never touched. Email goes to `outbox`.
 */

const run = randomUUID().slice(0, 8);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ownerEmail = `zztest-lifecycle-${run}@example.invalid`;

let org: ProvisionedOrg;
const start = new Date();
const trialEndsAt = new Date(start.getTime() + 12 * HOUR); // ends tomorrow, in under a day

const job = (now: Date) => runSubscriptionLifecycle(now, { orgIds: [org.orgId] });
const mailFor = () => outbox.filter((m) => m.to === ownerEmail);

beforeAll(async () => {
  await connectDatabase();
  org = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: `ZZTEST Lifecycle ${run}` },
        owner: { name: 'Lifecycle Owner', email: ownerEmail, password: 'Life1234!', emailVerified: true },
        status: 'TRIAL',
        trialDays: 1,
        planCode: null,
        signupSource: 'PLATFORM',
      },
      session,
    ),
  );
  await Org.updateOne({ _id: org.orgId }, { $set: { trialEndsAt } });
}, 120_000);

afterAll(async () => {
  if (org) await cleanupOrg(org.orgId);
  await disconnectDatabase();
});

describe('the daily subscription job', () => {
  it('sends the "ends tomorrow" reminder, once however often it runs', async () => {
    const first = await job(start);
    expect(first).toMatchObject({ checked: 1, emailsSent: 1, markedPastDue: 0 });
    const mail = mailFor();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Your free trial ends tomorrow');

    const again = await job(new Date(start.getTime() + HOUR));
    expect(again.emailsSent).toBe(0);
    expect(mailFor()).toHaveLength(1);
  });

  it('the next day, marks it past due by itself and says payment is due', async () => {
    const nextDay = new Date(start.getTime() + DAY);
    const res = await job(nextDay);
    expect(res).toMatchObject({ markedPastDue: 1, emailsSent: 1 });

    const stored = await Org.findById(org.orgId).lean();
    expect(stored?.status).toBe('PAST_DUE');
    expect(mailFor().at(-1)!.subject).toBe('Payment due — your free trial has ended');

    // A second run that day changes nothing and sends nothing.
    expect(await job(new Date(nextDay.getTime() + HOUR))).toMatchObject({
      markedPastDue: 0,
      emailsSent: 0,
    });
  });

  it('after the grace period, says it is read-only — once', async () => {
    const later = new Date(trialEndsAt.getTime() + (config.saas.graceDays + 1) * DAY);
    expect((await job(later)).emailsSent).toBe(1);
    expect(mailFor().at(-1)!.subject).toMatch(/is now read-only$/);
    expect((await job(new Date(later.getTime() + DAY))).emailsSent).toBe(0);

    const keys = await SubscriptionNotice.find({ orgId: org.orgId }).select('kind').lean();
    expect(keys.map((k) => k.kind).sort()).toEqual(['ENDING', 'EXPIRED', 'READ_ONLY']);
  });

  it('a renewal starts the reminders over for the new end date', async () => {
    const paidUntil = new Date(start.getTime() + 2 * DAY);
    await Org.updateOne(
      { _id: org.orgId },
      { $set: { status: 'ACTIVE', currentPeriodEndsAt: paidUntil } },
    );
    expect((await job(start)).emailsSent).toBe(1);
    expect(mailFor().at(-1)!.subject).toBe('Your subscription ends in 2 days');
  });
});

describe('weekStartOf', () => {
  it('is the Monday of the week in Dhaka time', () => {
    // Sunday 19 Oct 2026, 20:00 UTC is already Monday 20 Oct, 02:00 in Dhaka.
    expect(weekStartOf(new Date('2026-10-19T20:00:00Z'))).toBe('2026-10-19');
    expect(weekStartOf(new Date('2026-10-18T12:00:00Z'))).toBe('2026-10-12');
  });
});
