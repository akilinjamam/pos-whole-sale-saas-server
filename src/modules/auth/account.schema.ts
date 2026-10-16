import { z } from 'zod';

import { password } from '../user/user.schema.js';

/** Signup: the business and its owner in one form. */
export const signupSchema = z
  .object({
    businessName: z.string().trim().min(2, 'At least 2 characters').max(120),
    ownerName: z.string().trim().min(1, 'Required').max(120),
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    phone: z.string().trim().max(40).nullable().optional(),
    password,
  })
  .strict();

export type SignupInput = z.infer<typeof signupSchema>;

/** The token from an email link: 32 random bytes in base64url — 43 characters. */
const token = z.string().trim().min(20, 'Invalid link').max(200, 'Invalid link');

export const verifyEmailSchema = z.object({ token }).strict();
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const forgotPasswordSchema = z
  .object({ email: z.string().trim().toLowerCase().email('Enter a valid email address') })
  .strict();
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({ token, password }).strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
