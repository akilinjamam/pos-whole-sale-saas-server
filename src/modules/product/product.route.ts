import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './product.controller.js';
import {
  createProductSchema,
  idParamSchema,
  listProductsQuerySchema,
  updateProductSchema,
} from './product.schema.js';
import { attachAutoBarcodeSku } from '../../middleware/barcodeSku.js';

const productRouter = Router();

productRouter.get(
  '/',
  authenticate,
  requirePermission('product:read'),
  validate({ query: listProductsQuerySchema }),
  ctrl.list,
);

productRouter.post(
  '/',
  authenticate,
  requirePermission('product:create'),
  validate({ body: createProductSchema }),
  attachAutoBarcodeSku,
  ctrl.create,
);

productRouter.get(
  '/:id',
  authenticate,
  requirePermission('product:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

productRouter.patch(
  '/:id',
  authenticate,
  requirePermission('product:update'),
  validate({ params: idParamSchema, body: updateProductSchema }),
  ctrl.update,
);

// DELETE deactivates — see the service. Invoice lines and ledger rows point here forever.
productRouter.delete(
  '/:id',
  authenticate,
  requirePermission('product:delete'),
  validate({ params: idParamSchema }),
  ctrl.deactivate,
);

export default productRouter;
