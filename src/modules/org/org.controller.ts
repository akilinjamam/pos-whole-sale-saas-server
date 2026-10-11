import { asyncHandler } from '../../lib/asyncHandler.js';
import { orgIdOf, requestActorOf } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';

import * as orgService from './org.service.js';

import type { UpdateOrgInput, UpdateOrgSettingsInput } from './org.schema.js';

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
