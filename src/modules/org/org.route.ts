import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './org.controller.js';
import {
  closeOrgSchema,
  planRequestSchema,
  updateOrgSchema,
  updateOrgSettingsSchema,
} from './org.schema.js';

/**
 * Every route carries `authenticate` explicitly even though app.ts mounts it defensively at
 * `/api/v1`. The duplication is the point: Day 3's coverage test reads this file, and a route
 * that relies on the blanket guard alone is exactly the kind of thing that stops being true
 * the moment someone adds a public mount.
 */
const orgRouter = Router();

orgRouter.get('/', authenticate, requirePermission('org:read'), ctrl.getCurrentOrg);

orgRouter.patch(
  '/',
  authenticate,
  requirePermission('org:update'),
  validate({ body: updateOrgSchema }),
  ctrl.updateCurrentOrg,
);

// Separate from the profile PATCH: these flags change posting behaviour, and 'settings:manage'
// is a different grant from editing the company's address.
orgRouter.patch(
  '/settings',
  authenticate,
  requirePermission('settings:manage'),
  validate({ body: updateOrgSettingsSchema }),
  ctrl.updateCurrentOrgSettings,
);

// Plan, status and usage (SaaS phase 4). Self-service: every signed-in user — a cashier included —
// needs to know their business is read-only and why, so it carries no permission. It is also
// exempt from the subscription check itself (`authenticate`), or an expired business could not
// read why it is expired.
orgRouter.get('/subscription', authenticate, ctrl.getSubscription);

// Ask the platform for a plan, or take the request back. `org:update`: choosing what the business
// pays for is the owner's call, not a cashier's. Under `/org/subscription`, so it stays open to a
// read-only business — the one most likely to need it.
orgRouter.post(
  '/subscription/plan-request',
  authenticate,
  requirePermission('org:update'),
  validate({ body: planRequestSchema }),
  ctrl.requestPlan,
);
orgRouter.delete(
  '/subscription/plan-request',
  authenticate,
  requirePermission('org:update'),
  ctrl.withdrawPlanRequest,
);

// The first-steps checklist on the dashboard (SaaS phase 3). Reading it is `org:read`, like the
// profile it summarises; closing it changes the business, so it is `org:update`.
orgRouter.get('/onboarding', authenticate, requirePermission('org:read'), ctrl.getOnboarding);
orgRouter.post(
  '/onboarding/dismiss',
  authenticate,
  requirePermission('org:update'),
  ctrl.dismissOnboarding,
);

// Everything the business has, as a zip (SaaS phase 7). Exempt from the subscription check in
// `authenticate`, like `/subscription`: read-only, suspended or closed, their data is theirs until
// it is purged.
orgRouter.get('/export', authenticate, requirePermission('org:export'), ctrl.exportOrg);

// The owner closes the business (SaaS phase 7). `org:update` gets them to the service, which then
// refuses anyone but the owner and wants the name and password.
orgRouter.post(
  '/close',
  authenticate,
  requirePermission('org:update'),
  validate({ body: closeOrgSchema }),
  ctrl.closeOrg,
);

export default orgRouter;
