import { asyncHandler } from '../../lib/asyncHandler.js';
import { orgIdOf, requestActorOf } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';

import {
  getSubscription as subscriptionOf,
  requestPlan as requestPlanFor,
  withdrawPlanRequest as withdrawPlanRequestFor,
} from '../../services/subscription.service.js';

import { closeOrg as closeOrgFor } from './orgClosure.service.js';
import { streamOrgExport } from './orgExport.service.js';
import * as orgService from './org.service.js';

import type {
  CloseOrgInput,
  PlanRequestInput,
  UpdateOrgInput,
  UpdateOrgSettingsInput,
} from './org.schema.js';

/**
 * Controllers do three things and no more: pull the verified identity off the request, call a
 * service, shape the response. They never touch a model — services own transactions, and a
 * controller that queries directly is how a write ends up outside one.
 */

export const getCurrentOrg = asyncHandler(async (req, res) => {
  sendData(res, await orgService.getOrg(orgIdOf(req)));
});

export const updateCurrentOrg = asyncHandler(async (req, res) => {
  const input = req.body as UpdateOrgInput;
  sendData(res, await orgService.updateOrg(requestActorOf(req), input));
});

export const updateCurrentOrgSettings = asyncHandler(async (req, res) => {
  const input = req.body as UpdateOrgSettingsInput;
  sendData(res, await orgService.updateOrgSettings(requestActorOf(req), input));
});

export const getOnboarding = asyncHandler(async (req, res) => {
  sendData(res, await orgService.getOnboarding(requestActorOf(req)));
});

export const dismissOnboarding = asyncHandler(async (req, res) => {
  sendData(res, await orgService.dismissOnboarding(requestActorOf(req)));
});

export const getSubscription = asyncHandler(async (req, res) => {
  sendData(res, await subscriptionOf(orgIdOf(req)));
});

export const requestPlan = asyncHandler(async (req, res) => {
  sendData(res, await requestPlanFor(requestActorOf(req), req.body as PlanRequestInput));
});

export const withdrawPlanRequest = asyncHandler(async (req, res) => {
  sendData(res, await withdrawPlanRequestFor(requestActorOf(req)));
});

/** Streams the zip itself — no `sendData`; a failure after the first byte cuts the download. */
export const exportOrg = asyncHandler(async (req, res) => {
  await streamOrgExport(requestActorOf(req), res);
});

export const closeOrg = asyncHandler(async (req, res) => {
  sendData(res, await closeOrgFor(requestActorOf(req), req.body as CloseOrgInput));
});
