import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as creditNotes from './creditNote.service.js';
import {
  allocateCreditNoteSchema,
  idParamSchema,
  listCreditNotesQuerySchema,
  listSalesReturnsQuerySchema,
  wholesaleReturnSchema,
} from './salesReturn.schema.js';
import * as service from './salesReturn.service.js';

import type { ListCreditNotesQuery, ListSalesReturnsQuery } from './salesReturn.schema.js';
import type { Request } from 'express';

const idOf = (req: Request) => toObjectId(req.params.id as string);

/**
 * Sales returns (Day 36): both channels listed here; wholesale ones posted here (counter returns
 * post through `/pos/returns`, inside a shift). Reading on `return:read`, posting on
 * `return:create` — a cash refund also needs `return:approve`, checked in the service.
 */
export const salesReturnRouter = Router();

salesReturnRouter.get(
  '/',
  authenticate,
  requirePermission('return:read'),
  validate({ query: listSalesReturnsQuerySchema }),
  asyncHandler(async (req, res) => {
    const page = await service.listSalesReturns(
      requestActorOf(req),
      req.query as unknown as ListSalesReturnsQuery,
    );
    sendPage(res, page.items, page.meta);
  }),
);
salesReturnRouter.get(
  '/invoice/:id',
  authenticate,
  requirePermission('return:create'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.getReturnableWholesaleInvoice(requestActorOf(req), idOf(req)));
  }),
);
salesReturnRouter.post(
  '/',
  authenticate,
  requirePermission('return:create'),
  validate({ body: wholesaleReturnSchema }),
  asyncHandler(async (req, res) => {
    sendCreated(res, await service.postWholesaleReturn(requestActorOf(req), req.body));
  }),
);
salesReturnRouter.get(
  '/:id',
  authenticate,
  requirePermission('return:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.getSalesReturn(requestActorOf(req), idOf(req)));
  }),
);

/** Credit notes (Day 36): reading on `creditNote:read`, spending one on `creditNote:create`. */
export const creditNoteRouter = Router();

creditNoteRouter.get(
  '/',
  authenticate,
  requirePermission('creditNote:read'),
  validate({ query: listCreditNotesQuerySchema }),
  asyncHandler(async (req, res) => {
    const page = await creditNotes.listCreditNotes(
      requestActorOf(req),
      req.query as unknown as ListCreditNotesQuery,
    );
    sendPage(res, page.items, page.meta);
  }),
);
creditNoteRouter.get(
  '/:id',
  authenticate,
  requirePermission('creditNote:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await creditNotes.getCreditNote(requestActorOf(req), idOf(req)));
  }),
);
creditNoteRouter.post(
  '/:id/allocate',
  authenticate,
  requirePermission('creditNote:create'),
  validate({ params: idParamSchema, body: allocateCreditNoteSchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await creditNotes.allocateCreditNote(requestActorOf(req), idOf(req), req.body),
    );
  }),
);
