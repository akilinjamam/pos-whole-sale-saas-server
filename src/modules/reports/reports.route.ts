import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import {
  collectionRegisterQuerySchema,
  deadStockQuerySchema,
  periodQuerySchema,
  salesReportQuerySchema,
  stockValuationQuerySchema,
} from '../../shared/reports.js';

import * as service from './reports.service.js';

import type { Permission } from '@shared/permissions.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Reports (Day 37) — each on its own permission, all location-checked (`requireLocation` refuses a
 * `locationId` the caller does not hold; without one the service scopes to theirs). The purchase
 * register lives with goods receipts (`GET /goods-receipts/register`, Day 35).
 */
const router = Router();

function report<Q>(
  path: string,
  permission: Permission,
  schema: ZodTypeAny,
  run: (actor: RequestActor, query: Q) => Promise<unknown>,
): void {
  const handlers: RequestHandler[] = [
    authenticate,
    requirePermission(permission),
    requireLocation,
    validate({ query: schema }),
    asyncHandler(async (req, res) => {
      sendData(res, await run(requestActorOf(req), req.query as unknown as Q));
    }),
  ];
  router.get(path, ...handlers);
}

report('/sales', 'report:sales', salesReportQuerySchema, service.salesReport);
report('/stock-valuation', 'report:stock', stockValuationQuerySchema, service.stockValuation);
report('/dispatch-register', 'report:sales', periodQuerySchema, service.dispatchRegister);
report(
  '/collections',
  'report:receivables',
  collectionRegisterQuerySchema,
  service.collectionRegister,
);
report('/shifts', 'report:pos', periodQuerySchema, service.shiftSummary);
report('/dead-stock', 'report:stock', deadStockQuerySchema, service.deadStock);

export default router;
