import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';

import { notifications } from './notifications.service.js';

/** `GET /notifications` (Day 39) — any signed-in user; each kind only for those who may act on it. */
const router = Router();

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    sendData(res, await notifications(requestActorOf(req)));
  }),
);

export default router;
