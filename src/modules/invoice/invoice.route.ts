import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import { idParamSchema, listInvoicesQuerySchema } from './invoice.schema.js';
import * as service from './invoice.service.js';

import type { ListInvoicesQuery } from './invoice.schema.js';

/** Invoices — read-only, on `invoice:read`. Raised by counter sales and posted challans. */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('invoice:read'),
  validate({ query: listInvoicesQuerySchema }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await service.listInvoices(
      requestActorOf(req),
      req.query as unknown as ListInvoicesQuery,
    );
    sendPage(res, items, meta);
  }),
);
router.get(
  '/:id/activity',
  authenticate,
  requirePermission('invoice:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.invoiceActivity(requestActorOf(req), toObjectId(req.params.id as string)),
    );
  }),
);
router.get(
  '/:id',
  authenticate,
  requirePermission('invoice:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.getInvoice(requestActorOf(req), toObjectId(req.params.id as string)),
    );
  }),
);

export default router;
