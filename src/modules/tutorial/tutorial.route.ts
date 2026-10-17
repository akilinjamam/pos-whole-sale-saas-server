import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { sendData } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';

import { publishedTutorials } from './tutorial.model.js';

/**
 * `GET /tutorials` — the training videos, for every signed-in user. No permission: they are public
 * YouTube videos, and the client shows each person only those for the modules their role and plan
 * open (the same rule as the sidebar).
 */
const router = Router();

router.get(
  '/',
  authenticate,
  asyncHandler(async (_req, res) => {
    sendData(res, await publishedTutorials());
  }),
);

export default router;
