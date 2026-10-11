import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { orgIdOf, requestActorOf } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import { seriesParamSchema, updateSeriesSchema } from './numberSeries.schema.js';
import * as service from './numberSeries.service.js';

import type { UpdateSeriesInput } from './numberSeries.schema.js';
import type { DocSeries } from '@shared/enums.js';

/**
 * Document number series — read on `org:read`, changed on `settings:manage`. The settings screen
 * that edits them arrives on Day 39; the API is here so numbering is configurable from Day 17.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('org:read'),
  asyncHandler(async (req, res) => {
    sendData(res, await service.listSeries(orgIdOf(req)));
  }),
);

router.patch(
  '/:series',
  authenticate,
  requirePermission('settings:manage'),
  validate({ params: seriesParamSchema, body: updateSeriesSchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.updateSeries(
        requestActorOf(req),
        req.params.series as DocSeries,
        req.body as UpdateSeriesInput,
      ),
    );
  }),
);

export default router;
