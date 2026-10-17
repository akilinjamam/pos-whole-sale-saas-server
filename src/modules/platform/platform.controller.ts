import { Types } from 'mongoose';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import { toPlatformAdminPayload } from './platformAdmin.model.js';
import * as admins from './platformAdmin.service.js';
import { platformActorOf } from './platformAudit.js';
import * as plans from './platformPlan.service.js';
import * as tutorials from './platformTutorial.service.js';
import * as tenants from './platformTenant.service.js';

import type {
  ChangePlanInput,
  CreateAdminInput,
  CreatePlanInput,
  CreateTutorialInput,
  CreateTenantInput,
  ExtendTrialInput,
  ListPaymentsQuery,
  ListTenantsQuery,
  PlatformLoginInput,
  PlatformPasswordInput,
  ReasonInput,
  RecordPaymentInput,
  UpdateAdminInput,
  UpdatePlanInput,
  UpdateTutorialInput,
} from './platform.schema.js';
import type { Request } from 'express';

/** Thin, like every controller: identity off the request, one service call, the response. */

const idOf = (req: Request) => new Types.ObjectId(req.params.id as string);

// ─── Auth ───────────────────────────────────────────────────────────────────────────────

export const login = asyncHandler(async (req, res) => {
  sendData(
    res,
    await admins.platformLogin(req.body as PlatformLoginInput, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }),
  );
});

export const me = asyncHandler(async (req, res) => {
  sendData(res, toPlatformAdminPayload(platformActorOf(req).admin));
});

export const logout = asyncHandler(async (req, res) => {
  await admins.platformLogout(platformActorOf(req));
  sendNoContent(res);
});

export const changePassword = asyncHandler(async (req, res) => {
  sendData(
    res,
    await admins.changePlatformPassword(
      platformActorOf(req),
      req.body as PlatformPasswordInput,
    ),
  );
});

// ─── Businesses ─────────────────────────────────────────────────────────────────────────

export const dashboard = asyncHandler(async (_req, res) => {
  sendData(res, await tenants.platformDashboard());
});

export const listTenants = asyncHandler(async (req, res) => {
  const { items, meta } = await tenants.listTenants(req.query as unknown as ListTenantsQuery);
  sendPage(res, items, meta);
});

export const getTenant = asyncHandler(async (req, res) => {
  sendData(res, await tenants.getTenant(idOf(req)));
});

export const createTenant = asyncHandler(async (req, res) => {
  sendCreated(
    res,
    await tenants.createTenant(platformActorOf(req), req.body as CreateTenantInput),
  );
});

export const suspendTenant = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tenants.suspendTenant(platformActorOf(req), idOf(req), req.body as ReasonInput),
  );
});

export const reactivateTenant = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tenants.reactivateTenant(platformActorOf(req), idOf(req), req.body as ReasonInput),
  );
});

export const cancelTenant = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tenants.cancelTenant(platformActorOf(req), idOf(req), req.body as ReasonInput),
  );
});

export const changeTenantPlan = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tenants.changeTenantPlan(
      platformActorOf(req),
      idOf(req),
      req.body as ChangePlanInput,
    ),
  );
});

export const dismissPlanRequest = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tenants.dismissPlanRequest(platformActorOf(req), idOf(req), req.body as ReasonInput),
  );
});

export const extendTrial = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tenants.extendTrial(platformActorOf(req), idOf(req), req.body as ExtendTrialInput),
  );
});

// ─── Payments ───────────────────────────────────────────────────────────────────────────

export const recordPayment = asyncHandler(async (req, res) => {
  sendCreated(
    res,
    await tenants.recordPayment(
      platformActorOf(req),
      idOf(req),
      req.body as RecordPaymentInput,
    ),
  );
});

export const listPayments = asyncHandler(async (req, res) => {
  const { items, meta } = await tenants.listPayments(req.query as unknown as ListPaymentsQuery);
  sendPage(res, items, meta);
});

export const getPayment = asyncHandler(async (req, res) => {
  sendData(res, await tenants.getPayment(idOf(req)));
});

// ─── Plans ──────────────────────────────────────────────────────────────────────────────

export const listPlans = asyncHandler(async (_req, res) => {
  sendData(res, await plans.listPlans());
});

export const createPlan = asyncHandler(async (req, res) => {
  sendCreated(res, await plans.createPlan(platformActorOf(req), req.body as CreatePlanInput));
});

export const updatePlan = asyncHandler(async (req, res) => {
  sendData(
    res,
    await plans.updatePlan(
      platformActorOf(req),
      String(req.params.code),
      req.body as UpdatePlanInput,
    ),
  );
});

// ─── Admins ─────────────────────────────────────────────────────────────────────────────

export const listAdmins = asyncHandler(async (_req, res) => {
  sendData(res, await admins.listAdmins());
});

export const createAdmin = asyncHandler(async (req, res) => {
  sendCreated(
    res,
    await admins.createAdmin(platformActorOf(req), req.body as CreateAdminInput),
  );
});

export const updateAdmin = asyncHandler(async (req, res) => {
  sendData(
    res,
    await admins.updateAdmin(platformActorOf(req), idOf(req), req.body as UpdateAdminInput),
  );
});

// ─── Tutorials ──────────────────────────────────────────────────────────────────────────

export const listTutorials = asyncHandler(async (_req, res) => {
  sendData(res, await tutorials.listTutorials());
});

export const createTutorial = asyncHandler(async (req, res) => {
  sendCreated(
    res,
    await tutorials.createTutorial(platformActorOf(req), req.body as CreateTutorialInput),
  );
});

export const updateTutorial = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tutorials.updateTutorial(
      platformActorOf(req),
      idOf(req),
      req.body as UpdateTutorialInput,
    ),
  );
});

export const deleteTutorial = asyncHandler(async (req, res) => {
  await tutorials.deleteTutorial(platformActorOf(req), idOf(req));
  sendNoContent(res);
});
