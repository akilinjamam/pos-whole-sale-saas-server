import { describe, expect, it } from 'vitest';

import {
  addMonths,
  hasRoomFor,
  lifecycleStep,
  paymentPeriod,
  planHasFeature,
  planLimit,
  subscriptionState,
} from '../src/domain/subscription.js';

import type { PlanRules } from '../src/domain/subscription.js';

const DAY = 86_400_000;
const now = new Date('2026-10-17T06:00:00.000Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);
const GRACE = 7;

describe('subscriptionState', () => {
  it('a running trial has full access and counts the days down', () => {
    const s = subscriptionState(
      { status: 'TRIAL', trialEndsAt: at(10), currentPeriodEndsAt: null },
      now,
      GRACE,
    );
    expect(s).toMatchObject({ status: 'TRIAL', access: 'FULL', daysLeft: 10, dueSince: null });
  });

  it('rounds a part day up, so the last day reads 1, not 0', () => {
    const s = subscriptionState(
      { status: 'TRIAL', trialEndsAt: new Date(now.getTime() + 3_600_000), currentPeriodEndsAt: null },
      now,
      GRACE,
    );
    expect(s.daysLeft).toBe(1);
  });

  it('an ended trial is PAST_DUE at once, but keeps full access through the grace period', () => {
    const s = subscriptionState(
      { status: 'TRIAL', trialEndsAt: at(-2), currentPeriodEndsAt: null },
      now,
      GRACE,
    );
    expect(s.status).toBe('PAST_DUE');
    expect(s.access).toBe('FULL');
    expect(s.dueSince?.toISOString()).toBe(at(-2).toISOString());
    expect(s.graceEndsAt?.toISOString()).toBe(at(5).toISOString());
    expect(s.daysLeft).toBe(5);
  });

  it('becomes read-only when the grace period ends', () => {
    const s = subscriptionState(
      { status: 'TRIAL', trialEndsAt: at(-GRACE), currentPeriodEndsAt: null },
      now,
      GRACE,
    );
    expect(s).toMatchObject({ status: 'PAST_DUE', access: 'READ_ONLY', daysLeft: 0 });
  });

  it('a paid period runs to its end date', () => {
    expect(
      subscriptionState(
        { status: 'ACTIVE', trialEndsAt: at(-40), currentPeriodEndsAt: at(20) },
        now,
        GRACE,
      ),
    ).toMatchObject({ status: 'ACTIVE', access: 'FULL', daysLeft: 20 });
    expect(
      subscriptionState(
        { status: 'ACTIVE', trialEndsAt: null, currentPeriodEndsAt: at(-30) },
        now,
        GRACE,
      ),
    ).toMatchObject({ status: 'PAST_DUE', access: 'READ_ONLY' });
  });

  it('an ACTIVE business with no end date never expires', () => {
    expect(
      subscriptionState({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEndsAt: null }, now, GRACE),
    ).toMatchObject({ status: 'ACTIVE', access: 'FULL', daysLeft: null });
  });

  it('a stored PAST_DUE stays past due even if a date says otherwise', () => {
    const s = subscriptionState(
      { status: 'PAST_DUE', trialEndsAt: null, currentPeriodEndsAt: at(-1) },
      now,
      GRACE,
    );
    expect(s).toMatchObject({ status: 'PAST_DUE', access: 'FULL', daysLeft: 6 });
    expect(
      subscriptionState({ status: 'PAST_DUE', trialEndsAt: null, currentPeriodEndsAt: null }, now, GRACE)
        .access,
    ).toBe('READ_ONLY');
  });

  it('suspended and cancelled businesses are blocked, whatever their dates', () => {
    for (const status of ['SUSPENDED', 'CANCELLED'] as const) {
      expect(
        subscriptionState({ status, trialEndsAt: at(30), currentPeriodEndsAt: at(30) }, now, GRACE)
          .access,
      ).toBe('BLOCKED');
    }
  });
});

describe('plan rules', () => {
  const starter: PlanRules = {
    limits: { users: 3, locations: 2, products: null },
    features: ['REPORTS'],
  };

  it('no plan grants everything', () => {
    expect(planHasFeature(null, 'POS')).toBe(true);
    expect(planLimit(null, 'users')).toBeNull();
    expect(hasRoomFor(null, 'users', 10_000)).toBe(true);
  });

  it('a plan grants only its features', () => {
    expect(planHasFeature(starter, 'REPORTS')).toBe(true);
    expect(planHasFeature(starter, 'POS')).toBe(false);
  });

  it('a limit allows up to, and not past, its cap', () => {
    expect(hasRoomFor(starter, 'users', 2)).toBe(true);
    expect(hasRoomFor(starter, 'users', 3)).toBe(false);
    expect(hasRoomFor(starter, 'products', 1_000_000)).toBe(true);
  });
});

describe('addMonths', () => {
  it('adds calendar months in UTC', () => {
    expect(addMonths(new Date('2026-10-17T06:00:00Z'), 1).toISOString()).toBe('2026-11-17T06:00:00.000Z');
    expect(addMonths(new Date('2026-10-17T06:00:00Z'), 12).toISOString()).toBe('2027-10-17T06:00:00.000Z');
  });

  it('clamps to the end of a shorter month', () => {
    expect(addMonths(new Date('2027-01-31T00:00:00Z'), 1).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
});

describe('paymentPeriod', () => {
  it('starts now for a business whose time has run out', () => {
    const p = paymentPeriod({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEndsAt: at(-10) }, now, 1);
    expect(p.start.toISOString()).toBe(now.toISOString());
    expect(p.end.toISOString()).toBe('2026-11-17T06:00:00.000Z');
  });

  it('extends from the end of a period still running — paying early loses nothing', () => {
    const p = paymentPeriod({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEndsAt: at(5) }, now, 1);
    expect(p.start.toISOString()).toBe(at(5).toISOString());
  });

  it('keeps the unused trial days', () => {
    const p = paymentPeriod({ status: 'TRIAL', trialEndsAt: at(4), currentPeriodEndsAt: null }, now, 3);
    expect(p.start.toISOString()).toBe(at(4).toISOString());
  });
});

describe('lifecycleStep (the daily job)', () => {
  const trial = (days: number) =>
    ({ status: 'TRIAL', trialEndsAt: at(days), currentPeriodEndsAt: null }) as const;

  it('says nothing while more than 7 days are left', () => {
    expect(lifecycleStep(trial(8), now, GRACE)).toMatchObject({ markPastDue: false, notice: null });
  });

  it('names the most urgent reminder stage reached', () => {
    expect(lifecycleStep(trial(7), now, GRACE).notice).toEqual({ kind: 'ENDING', stage: 7, daysLeft: 7 });
    expect(lifecycleStep(trial(5), now, GRACE).notice).toMatchObject({ stage: 7 });
    expect(lifecycleStep(trial(3), now, GRACE).notice).toMatchObject({ stage: 3 });
    expect(lifecycleStep(trial(2), now, GRACE).notice).toMatchObject({ stage: 3 });
    // Ends tomorrow — under a day away.
    expect(lifecycleStep(trial(0.5), now, GRACE).notice).toMatchObject({ stage: 1, daysLeft: 1 });
  });

  it('marks an ended trial past due and tells them, with the grace end', () => {
    const step = lifecycleStep(trial(-1), now, GRACE);
    expect(step).toMatchObject({ markPastDue: true, isTrial: true });
    expect(step.notice).toEqual({ kind: 'EXPIRED', graceEndsAt: at(GRACE - 1) });
  });

  it('does not mark again once PAST_DUE is stored, and says read-only after the grace period', () => {
    const stored = { status: 'PAST_DUE', trialEndsAt: at(-3), currentPeriodEndsAt: null } as const;
    expect(lifecycleStep(stored, now, GRACE)).toMatchObject({
      markPastDue: false,
      notice: { kind: 'EXPIRED' },
    });
    const late = { ...stored, trialEndsAt: at(-GRACE) };
    expect(lifecycleStep(late, now, GRACE).notice).toEqual({ kind: 'READ_ONLY' });
  });

  it('follows the paid period once they have paid, and words it as a renewal', () => {
    const paid = { status: 'ACTIVE', trialEndsAt: at(-40), currentPeriodEndsAt: at(3) } as const;
    const step = lifecycleStep(paid, now, GRACE);
    expect(step).toMatchObject({ isTrial: false, endsAt: at(3), notice: { stage: 3 } });
    const lapsed = lifecycleStep({ ...paid, currentPeriodEndsAt: at(-1) }, now, GRACE);
    expect(lapsed).toMatchObject({ markPastDue: true, isTrial: false });
  });

  it('leaves alone suspended, closed and open-ended businesses', () => {
    for (const status of ['SUSPENDED', 'CANCELLED'] as const) {
      expect(lifecycleStep({ ...trial(-30), status }, now, GRACE)).toMatchObject({
        markPastDue: false,
        notice: null,
      });
    }
    expect(
      lifecycleStep({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEndsAt: null }, now, GRACE)
        .notice,
    ).toBeNull();
  });
});
