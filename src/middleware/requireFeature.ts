import { assertFeature } from '../services/subscription.service.js';

import type { PlanFeature } from '@shared/enums.js';
import type { RequestHandler } from 'express';

/**
 * Gate a whole module on the business's plan (SaaS phase 4) — mounted in front of a router from the
 * route table (`feature` on a `RouteEntry`), so it runs after the blanket `authenticate` in app.ts
 * has set `req.subscription`. No subscription on the request means no authenticated caller; the
 * route's own `authenticate` answers that.
 */
export function requireFeature(feature: PlanFeature): RequestHandler {
  return (req, _res, next) => {
    try {
      if (req.subscription) assertFeature(req.subscription, feature);
      next();
    } catch (err) {
      next(err);
    }
  };
}
