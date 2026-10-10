import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';

import { dashboard } from './dashboard.service.js';

/**
 * `GET /dashboard` (Day 38) — any signed-in user; each section is included only for those who
 * hold the permission of the report behind it.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    sendData(res, await dashboard(requestActorOf(req)));
  }),
);

export default router;
