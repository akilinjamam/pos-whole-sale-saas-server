import type { PlatformAdminDoc } from '../modules/platform/platformAdmin.model.js';
import type { OrgAccess } from '../services/subscription.service.js';
import type { AuthUser } from '@shared/types.js';

/**
 * `req.user`, typed.
 *
 * This replaces the retail system's habit of re-parsing the Authorization header in a helper
 * every time something needed the branch (`getBranchId`, `addBranch*`). Here the token is
 * verified once, in `authenticate`, and everything downstream reads a typed object — so
 * `req.user!.orgId` is a string, not a `string | undefined` that half the callers forgot.
 *
 * Optional on the type because Express has no way to know a handler sits behind the guard;
 * controllers use `requireAuth(req)` from `lib/requestUser.ts` to narrow it in one step.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** The business's plan and subscription state, set by `authenticate` (SaaS phase 4). */
      subscription?: OrgAccess;
      /** The signed-in platform admin, set by `authenticatePlatform` (SaaS phase 5). */
      platformAdmin?: PlatformAdminDoc;
    }
  }
}

export {};
