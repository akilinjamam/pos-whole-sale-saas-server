import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { config } from '../../config/env.js';
import {
  authenticatePlatform,
  requirePlatformPermission,
} from '../../middleware/platformAuth.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './platform.controller.js';
import {
  changePlanSchema,
  codeParamSchema,
  createAdminSchema,
  createPlanSchema,
  createTenantSchema,
  extendTrialSchema,
  idParamSchema,
  listPaymentsQuerySchema,
  listTenantsQuerySchema,
  platformLoginSchema,
  platformPasswordSchema,
  reasonSchema,
  recordPaymentSchema,
  updateAdminSchema,
  updatePlanSchema,
} from './platform.schema.js';

/**
 * `/api/v1/platform` — the platform-admin API (SaaS phase 5).
 *
 * Mounted `public` in the route table so the **tenant** blanket guard does not run: a platform
 * token is not a tenant token, and would be refused. Every route here carries the platform guards
 * instead, and `tests/routeCoverage.test.ts` checks that each one does.
 */
const router = Router();
const auth = authenticatePlatform;
const can = requirePlatformPermission;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.saas.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again shortly.' },
  },
});

// ── Auth ──
router.post('/auth/login', loginLimiter, validate({ body: platformLoginSchema }), ctrl.login);
router.get('/auth/me', auth, ctrl.me);
router.post('/auth/logout', auth, ctrl.logout);
router.post(
  '/auth/password',
  auth,
  validate({ body: platformPasswordSchema }),
  ctrl.changePassword,
);

// ── Businesses ──
router.get('/dashboard', auth, can('platform:tenants'), ctrl.dashboard);
router.get(
  '/tenants',
  auth,
  can('platform:tenants'),
  validate({ query: listTenantsQuerySchema }),
  ctrl.listTenants,
);
router.post(
  '/tenants',
  auth,
  can('platform:tenants'),
  validate({ body: createTenantSchema }),
  ctrl.createTenant,
);
router.get(
  '/tenants/:id',
  auth,
  can('platform:tenants'),
  validate({ params: idParamSchema }),
  ctrl.getTenant,
);
router.post(
  '/tenants/:id/suspend',
  auth,
  can('platform:tenants'),
  validate({ params: idParamSchema, body: reasonSchema }),
  ctrl.suspendTenant,
);
router.post(
  '/tenants/:id/reactivate',
  auth,
  can('platform:tenants'),
  validate({ params: idParamSchema, body: reasonSchema }),
  ctrl.reactivateTenant,
);
router.post(
  '/tenants/:id/cancel',
  auth,
  can('platform:tenants'),
  validate({ params: idParamSchema, body: reasonSchema }),
  ctrl.cancelTenant,
);
router.post(
  '/tenants/:id/plan',
  auth,
  can('platform:tenants'),
  validate({ params: idParamSchema, body: changePlanSchema }),
  ctrl.changeTenantPlan,
);
router.post(
  '/tenants/:id/plan-request/dismiss',
  auth,
  can('platform:tenants'),
  validate({ params: idParamSchema, body: reasonSchema }),
  ctrl.dismissPlanRequest,
);
router.post(
  '/tenants/:id/extend-trial',
  auth,
  can('platform:tenants'),
  validate({ params: idParamSchema, body: extendTrialSchema }),
  ctrl.extendTrial,
);

// ── Payments ──
router.post(
  '/tenants/:id/payments',
  auth,
  can('platform:billing'),
  validate({ params: idParamSchema, body: recordPaymentSchema }),
  ctrl.recordPayment,
);
router.get(
  '/payments',
  auth,
  can('platform:billing'),
  validate({ query: listPaymentsQuerySchema }),
  ctrl.listPayments,
);
router.get(
  '/payments/:id',
  auth,
  can('platform:billing'),
  validate({ params: idParamSchema }),
  ctrl.getPayment,
);

// ── Plans ── Reading them is part of running businesses (the change-plan picker); editing is not.
router.get('/plans', auth, can('platform:tenants'), ctrl.listPlans);
router.post(
  '/plans',
  auth,
  can('platform:plans'),
  validate({ body: createPlanSchema }),
  ctrl.createPlan,
);
router.patch(
  '/plans/:code',
  auth,
  can('platform:plans'),
  validate({ params: codeParamSchema, body: updatePlanSchema }),
  ctrl.updatePlan,
);

// ── Admins ──
router.get('/admins', auth, can('platform:admins'), ctrl.listAdmins);
router.post(
  '/admins',
  auth,
  can('platform:admins'),
  validate({ body: createAdminSchema }),
  ctrl.createAdmin,
);
router.patch(
  '/admins/:id',
  auth,
  can('platform:admins'),
  validate({ params: idParamSchema, body: updateAdminSchema }),
  ctrl.updateAdmin,
);

export default router;
