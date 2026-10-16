import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './org.controller.js';
import { updateOrgSchema, updateOrgSettingsSchema } from './org.schema.js';

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

// The first-steps checklist on the dashboard (SaaS phase 3). Reading it is `org:read`, like the
// profile it summarises; closing it changes the business, so it is `org:update`.
orgRouter.get('/onboarding', authenticate, requirePermission('org:read'), ctrl.getOnboarding);
orgRouter.post(
  '/onboarding/dismiss',
  authenticate,
  requirePermission('org:update'),
  ctrl.dismissOnboarding,
);

export default orgRouter;
