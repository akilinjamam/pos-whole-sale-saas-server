import { describe, expect, it } from 'vitest';

import {
  hasRoomFor,
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
