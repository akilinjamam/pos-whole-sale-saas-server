import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { ALL_PERMISSIONS } from '../../shared/permissions.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

const permissionList = z
  .array(z.string())
  .superRefine((values, ctx) => {
    const known = new Set<string>(ALL_PERMISSIONS);
    values.forEach((value, index) => {
      if (!known.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Unknown permission "${value}"`,
        });
      }
    });
  })
  .transform((values) => [...new Set(values)]);

/**
 * Minimum password rules. Deliberately length-led rather than a symbol-class gauntlet: this is
 * a shop floor where people type on a counter terminal, and a rule that forces `Pa$$w0rd!` onto
 * a sticky note beside the till is worse than one that asks for something longer.
 */
/** The one password rule — also used by signup and password reset. */
export const password = z.string().min(8, 'At least 8 characters').max(128);

export const idParamSchema = z.object({ id: objectId });

export const createUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().max(40).nullable().optional(),
    password,
    roleIds: z.array(objectId).min(1, 'A user needs at least one role'),
    permissionGrants: permissionList.default([]),
    permissionRevokes: permissionList.default([]),
    /** Empty means unrestricted — how OWNER and ADMIN are modelled. See `requireLocation`. */
    locationIds: z.array(objectId).default([]),
    defaultLocationId: objectId.nullable().optional(),
    isActive: z.boolean().optional(),
    mustChangePassword: z.boolean().optional(),
  })
  .strict()
  .refine(
    (u) =>
      !u.defaultLocationId ||
      u.locationIds.length === 0 ||
      u.locationIds.includes(u.defaultLocationId),
    {
      path: ['defaultLocationId'],
      message: 'Default location must be one of the assigned locations',
    },
  );

export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Password is not updatable here — it has its own endpoint, with its own permission
 * (`user:resetPassword`) and its own audit meaning. Folding it into a general PATCH would let
 * anyone with `user:update` take over an account.
 */
export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    roleIds: z.array(objectId).min(1, 'A user needs at least one role').optional(),
    permissionGrants: permissionList.optional(),
    permissionRevokes: permissionList.optional(),
    locationIds: z.array(objectId).optional(),
    defaultLocationId: objectId.nullable().optional(),
    isActive: z.boolean().optional(),
    mustChangePassword: z.boolean().optional(),
  })
  .strict();

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/** An administrator resetting someone else's password. No current password required. */
export const resetPasswordSchema = z
  .object({
    password,
    /** Default true: a password someone else chose should not stay in use. */
    mustChangePassword: z.boolean().default(true),
  })
  .strict();

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** A user changing their own password. The current one is required — see auth.service. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Required'),
    newPassword: password,
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'The new password must be different',
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const listUsersQuerySchema = listQuerySchema.extend({
  roleId: objectId.optional(),
  locationId: objectId.optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
