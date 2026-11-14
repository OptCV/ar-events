import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const email = z.string().trim().toLowerCase().pipe(z.email({ message: 'Enter a valid email address.' }).max(254, 'Email is too long.'));
const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

/** Client-side form validation; the server (Better Auth) enforces the same limits. */
export const SignUpInput = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(80, 'Name is too long.'),
  email,
  password,
});
export type SignUpInput = z.infer<typeof SignUpInput>;

export const SignInInput = z.object({
  email,
  password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX_LENGTH),
});
export type SignInInput = z.infer<typeof SignInInput>;

export const ForgotPasswordInput = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;

export const ResetPasswordInput = z
  .object({ password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match.' });
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>;

/** GET /api/auth-config — what the UI may offer. Public sign-up stays off until email + security are verified. */
export const AuthConfigResponse = z.object({
  signupEnabled: z.boolean(),
  emailVerificationRequired: z.literal(true),
  passwordMinLength: z.number().int(),
  passwordMaxLength: z.number().int(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;

export const SessionUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUser>;

/** GET /api/me — protected; 401 without a valid session. */
export const MeResponse = z.object({ user: SessionUser });
export type MeResponse = z.infer<typeof MeResponse>;

/** GET /api/session — public; 200 with `user: null` when signed out (the UI's auth state source). */
export const SessionResponse = z.object({ user: SessionUser.nullable() });
export type SessionResponse = z.infer<typeof SessionResponse>;
