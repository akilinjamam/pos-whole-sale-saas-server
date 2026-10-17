import { Router } from 'express';

import { config } from '../../config/env.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { sendData } from '../../lib/respond.js';
import { activePlans } from '../../services/subscription.service.js';

import type { PublicSitePayload } from '@shared/types.js';

/**
 * The signed-out website's data (SaaS phase 8). Public by design — it says only what the pricing
 * page and the legal pages print anyway — and cacheable for a few minutes by browsers and proxies.
 */
const publicRouter = Router();

publicRouter.get(
  '/site',
  asyncHandler(async (_req, res) => {
    const payload: PublicSitePayload = {
      plans: await activePlans(),
      signupEnabled: config.saas.signupEnabled,
      trialDays: config.saas.trialDays,
      trialPlanCode: config.saas.trialPlanCode,
      graceDays: config.saas.graceDays,
      purgeAfterDays: config.saas.purgeAfterDays,
      operator: { ...config.site },
    };
    res.setHeader('Cache-Control', 'public, max-age=300');
    sendData(res, payload);
  }),
);

export default publicRouter;
