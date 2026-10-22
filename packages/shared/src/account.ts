/**
 * Account security wire types: sign-in with a second factor or a passkey,
 * recovery by email, step-up, and the account security page. Normative
 * source for routes and bodies: docs/cloudflare/ARCHITECTURE.md §5.2.
 *
 * Conventions
 * - Times are ISO 8601 UTC strings. Edits are POST, removals DELETE (no PATCH).
 * - Errors are `{ error: string, code?: AuthApiErrorCode, ... }`; infrastructure
 *   failures are 503 `{ error, retryable: true }` with Retry-After.
 * - `remember` ("Keep me signed in") defaults to true on register, login, MFA
 *   completion and passkey sign-in.
 * - WebAuthn options and credentials are the @simplewebauthn JSON shapes,
 *   typed `unknown` here so this package needs no WebAuthn dependency.
 */
import type { AuthResponse } from "./api.js";

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/** How a session signed in or last stepped up (Session.authMethods / reauthMethods). */
export type AuthMethod = "pwd" | "otp" | "backup" | "passkey";
/** Second factors accepted after a correct password. */
export type SecondFactorMethod = "totp" | "backup_code";

/**
 * 200 from POST /api/auth/login (and /api/auth/reauth/password) when the
 * account has TOTP: the password was right, no session exists yet.
 */
export interface MfaChallenge {
  mfaRequired: true;
  /** Signed, single use, bound to this browser; 5 minutes. */
  mfaTicket: string;
  methods: SecondFactorMethod[];
  expiresAt: string;
}

export type LoginResponse = AuthResponse | MfaChallenge;

export function isMfaChallenge(response: LoginResponse): response is MfaChallenge {
  return (response as MfaChallenge).mfaRequired === true;
}

/** POST /api/auth/login/mfa, and /api/auth/reauth/mfa (which ignores remember). */
export interface MfaVerifyRequest {
  mfaTicket: string;
  method: SecondFactorMethod;
  /** Six digits, or a backup code ("XXXXX-XXXXX"; case, spaces and dashes are ignored). */
  code: string;
  /** Default: the choice sent with the password. */
  remember?: boolean;
}

/** From POST /api/auth/passkey/options, /api/auth/reauth/passkey/options and /api/account/passkeys/options. */
export interface PasskeyOptionsResponse {
  /** PublicKeyCredentialCreationOptionsJSON or PublicKeyCredentialRequestOptionsJSON. */
  options: unknown;
  /** Signed and single use; send it back unchanged. 5 minutes. */
  challengeToken: string;
}

/** POST /api/auth/passkey/login (discoverable credential, user verification required). */
export interface PasskeyLoginRequest {
  challengeToken: string;
  /** AuthenticationResponseJSON. */
  credential: unknown;
  remember?: boolean;
}

/** POST /api/auth/reauth/passkey. */
export interface PasskeyReauthRequest {
  challengeToken: string;
  /** AuthenticationResponseJSON. */
  credential: unknown;
}

/** POST /api/account/passkeys. */
export interface PasskeyRegisterRequest {
  challengeToken: string;
  /** RegistrationResponseJSON. */
  credential: unknown;
  /** 1-64 characters. Default: the browser and OS, e.g. "Chrome on Windows". */
  name?: string;
}

/** POST /api/account/passkeys/:id/rename. */
export interface PasskeyRenameRequest {
  name: string;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  deviceType: "singleDevice" | "multiDevice";
  transports: string[];
}

// ---------------------------------------------------------------------------
// Recovery by email (tokens travel in the URL fragment, #t=..., and are POSTed)
// ---------------------------------------------------------------------------

/** POST /api/auth/password/forgot. Always 202 `{ ok: true }` once Turnstile passes. */
export interface ForgotPasswordRequest {
  email: string;
  turnstileToken?: string;
}

/** POST /api/auth/password/reset. 204; every session is signed out and nobody is signed in. */
export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

/** POST /api/auth/email/verify, /api/auth/email/change/confirm and /api/auth/security/lockdown. */
export interface EmailTokenRequest {
  token: string;
}

/** 200 from POST /api/auth/email/verify. */
export interface EmailVerifiedResponse {
  emailVerified: true;
}

/** 200 from POST /api/auth/email/change/confirm. */
export interface EmailChangedResponse {
  email: string;
}

/**
 * 200 from POST /api/auth/security/lockdown ("This wasn't me"): every session
 * is signed out, factors added since the incident are removed, and resetToken
 * (a PASSWORD_RESET token, 30 minutes) sets the new password on the same page.
 */
export interface LockdownResponse {
  secured: true;
  resetToken: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Step-up for account changes (the session window, STEP_UP_WINDOW_MS)
// ---------------------------------------------------------------------------

/** POST /api/auth/reauth/password. With TOTP on, the answer is an MfaChallenge instead. */
export interface ReauthPasswordRequest {
  password: string;
}

export interface StepUpResult {
  reauthenticatedUntil: string;
}

export type ReauthMethod = "password" | "passkey";

/** 403 from a route that needs a fresh step-up (never 401, so the session is not mistaken for dead). */
export interface ReauthRequiredBody {
  error: string;
  code: "REAUTH_REQUIRED";
  methods: ReauthMethod[];
  /** The step-up must have included the password, or a second factor. */
  needs?: "password" | "second_factor";
}

// ---------------------------------------------------------------------------
// Step-up for money: a single-use grant bound to one action (StepUpGrant)
// ---------------------------------------------------------------------------

/** What a grant authorises (StepUpGrant.purpose); the payments Worker matches these literally. */
export const STEP_UP_PURPOSES = ["withdrawal", "payout_destination", "admin_payments"] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

/** How a grant was proven (StepUpGrant.method). TOTP covers a backup code. */
export const STEP_UP_GRANT_METHODS = ["PASSKEY", "TOTP", "PASSWORD_EMAIL", "PASSWORD"] as const;
export type StepUpGrantMethod = (typeof STEP_UP_GRANT_METHODS)[number];

/**
 * The methods each purpose accepts. The database (StepUpGrant_method_strength)
 * refuses any other: PASSWORD alone never authorises money, and admin payment
 * decisions need a passkey. The API also refuses PASSWORD_EMAIL to a user who
 * has TOTP or a passkey: such a user must use that second factor.
 */
export const STEP_UP_METHODS_BY_PURPOSE: Readonly<Record<StepUpPurpose, readonly StepUpGrantMethod[]>> = {
  withdrawal: ["PASSKEY", "TOTP", "PASSWORD_EMAIL"],
  payout_destination: ["PASSKEY", "TOTP", "PASSWORD_EMAIL"],
  admin_payments: ["PASSKEY"],
};

export type StepUpProof =
  /** A passkey assertion with user verification (method PASSKEY). */
  | { kind: "passkey"; challengeToken: string; credential: unknown }
  /** The password plus a TOTP code or a backup code (method TOTP). */
  | { kind: "totp"; password: string; code: string }
  /** The password plus the emailed code (method PASSWORD_EMAIL); only without TOTP and passkeys. */
  | { kind: "password_email"; password: string; emailCode: string; emailChallengeToken: string };

/** POST /api/auth/step-up (Bearer). */
export interface StepUpGrantRequest {
  purpose: StepUpPurpose;
  /** Lower-case hex SHA-256 of the canonical action, as returned by the payments route that needs the grant. */
  bind: string;
  proof: StepUpProof;
}

/** 200 from POST /api/auth/step-up. Pass stepUpGrantId to the money route before expiresAt; it works once. */
export interface StepUpGrantResponse {
  stepUpGrantId: string;
  expiresAt: string;
}

/** POST /api/auth/step-up/email-code (Bearer): emails a STEP_UP_EMAIL_CODE_DIGITS-digit code. */
export interface StepUpEmailCodeRequest {
  purpose: StepUpPurpose;
  bind: string;
}

/** 202 from POST /api/auth/step-up/email-code. The code is bound to this session, purpose and bind. */
export interface StepUpEmailCodeResponse {
  emailChallengeToken: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Account changes and the security page
// ---------------------------------------------------------------------------

/** POST /api/account/password. Needs a step-up that included the password. */
export interface ChangePasswordRequest {
  newPassword: string;
}

export interface ChangePasswordResponse {
  /** Other sessions signed out; the current one stays. */
  revokedSessions: number;
}

/** POST /api/account/email. */
export interface ChangeEmailRequest {
  newEmail: string;
}

/** 202 from POST /api/account/email: a confirmation link went to the new address. */
export interface ChangeEmailResponse {
  ok: true;
  pendingEmail: string;
}

/** 200 from POST /api/account/2fa/totp/setup. Confirm within expiresAt with TotpEnableRequest. */
export interface TotpSetupResponse {
  /** Base32, for manual entry. */
  secret: string;
  otpauthUri: string;
  expiresAt: string;
}

/** POST /api/account/2fa/totp/enable. */
export interface TotpEnableRequest {
  code: string;
}

/** Shown once: from TOTP enable and POST /api/account/2fa/backup-codes. */
export interface BackupCodesResponse {
  backupCodes: string[];
}

/** 200 from GET /api/auth/config (no auth): what this deployment offers. */
export interface AuthClientConfig {
  termsVersion: string;
  emailEnabled: boolean;
  passkeysEnabled: boolean;
  totpEnabled: boolean;
  stepUpWindowMs: number;
  passwordMinLength: number;
  breachCheck: boolean;
}

/** 200 from GET /api/account/security. */
export interface AccountSecurity {
  email: string | null;
  emailVerified: boolean;
  /** The newest unconfirmed email change. */
  pendingEmail: string | null;
  passwordChangedAt: string | null;
  totp: { enabled: boolean; enabledAt: string | null; backupCodesRemaining: number };
  passkeys: PasskeySummary[];
  /** End of the current session's step-up window, if it is fresh. */
  stepUpUntil: string | null;
  /** Withdrawals and payout-destination changes are held until then. */
  securityHoldUntil: string | null;
  capabilities: { email: boolean; passkeys: boolean; totp: boolean };
}

export interface KnownDeviceSummary {
  id: string;
  label: string | null;
  country: string | null;
  /** Coarse network only (/24 or /48). */
  ip: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** This browser. */
  current: boolean;
}

/** 200 from GET /api/account/devices. */
export interface KnownDevicesResponse {
  devices: KnownDeviceSummary[];
}

/** 200 from GET /api/account/passkeys. */
export interface PasskeysResponse {
  passkeys: PasskeySummary[];
}

// ---------------------------------------------------------------------------
// Security history (AccountSecurityEvent.type)
// ---------------------------------------------------------------------------

/**
 * One fact per event. Notes on kinds that read alike:
 * - TOTP_ENABLED / TOTP_DISABLED / BACKUP_CODES_REGENERATED: the owner's own
 *   changes. TOTP_CHANGED: a lockdown removed or restored the TOTP factor
 *   (data.change "removed" | "restored").
 * - NOT_ME_REPORTED: the owner redeemed a "This wasn't me" link (the lockdown
 *   route; data.kind is the notice, data.incidentAt). ACCOUNT_LOCKDOWN is
 *   reserved for a lockdown started by support, not by the owner.
 * - STEP_UP: a session window step-up or a money grant (data.purpose, data.method).
 */
export const SECURITY_EVENT_TYPES = [
  "SIGN_IN", "SIGN_IN_NEW_DEVICE", "LOGIN_LOCKOUT", "MFA_LOCKOUT",
  "PASSWORD_CHANGED", "PASSWORD_RESET_REQUESTED", "PASSWORD_RESET",
  "EMAIL_VERIFIED", "EMAIL_CHANGE_REQUESTED", "EMAIL_CHANGED",
  "TOTP_ENABLED", "TOTP_DISABLED", "TOTP_CHANGED", "BACKUP_CODES_REGENERATED", "BACKUP_CODE_USED",
  "PASSKEY_ADDED", "PASSKEY_REMOVED", "DEVICE_FORGOTTEN", "LOGOUT_ALL", "REFRESH_REUSE",
  "NOT_ME_REPORTED", "ACCOUNT_LOCKDOWN", "STEP_UP",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/**
 * A credential or second-factor change: the payments review rule
 * RECENT_SECURITY_CHANGE looks for any of these (docs/money/WALLET.md).
 * "This wasn't me" is NOT_ME_REPORTED, its own rule.
 */
export const RECENT_SECURITY_CHANGE_EVENT_TYPES = [
  "PASSWORD_CHANGED", "PASSWORD_RESET", "EMAIL_CHANGED",
  "TOTP_ENABLED", "TOTP_DISABLED", "TOTP_CHANGED", "BACKUP_CODES_REGENERATED", "PASSKEY_ADDED",
] as const satisfies readonly SecurityEventType[];

export interface SecurityEventSummary {
  id: string;
  type: SecurityEventType;
  createdAt: string;
  /** Coarse network only. */
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  /** Never a token, code, password, link or full IP address. */
  data: Record<string, unknown>;
}

/** 200 from GET /api/account/events?before=<ISO>&limit=<1-50>. */
export interface SecurityEventsResponse {
  events: SecurityEventSummary[];
  /** Pass as `before` for the next page; null at the end. */
  next: string | null;
}

/** `code` values of account-security error bodies. */
export type AuthApiErrorCode =
  | "TURNSTILE_FAILED" | "TERMS_REQUIRED" | "TERMS_OUTDATED" | "PASSWORD_BREACHED" | "PASSWORD_WEAK"
  | "PASSWORD_RESET_REQUIRED" | "MFA_INVALID" | "MFA_TICKET_INVALID" | "MFA_LOCKED" | "REAUTH_REQUIRED"
  | "TOKEN_INVALID" | "EMAIL_UNAVAILABLE" | "EMAIL_NOT_VERIFIED" | "EMAIL_ALREADY_VERIFIED" | "EMAIL_MISSING"
  | "MAIL_UNAVAILABLE" | "PASSKEY_INVALID" | "PASSKEY_ALREADY_REGISTERED" | "PASSKEY_LIMIT" | "NO_PASSKEYS"
  | "CHALLENGE_INVALID" | "PASSKEYS_UNAVAILABLE" | "SECURITY_NOT_CONFIGURED" | "TOTP_ALREADY_ENABLED"
  | "TOTP_NOT_PENDING" | "TOTP_INVALID" | "TOTP_NOT_ENABLED" | "SECURITY_HOLD" | "ADMIN_PASSKEY_REQUIRED"
  /** Money step-up: this proof kind is not allowed for the purpose or this account (see STEP_UP_METHODS_BY_PURPOSE). */
  | "STEP_UP_METHOD_NOT_ALLOWED"
  /** Money step-up: wrong emailed code. Expired, used, exhausted or mismatched challenges are CHALLENGE_INVALID. */
  | "EMAIL_CODE_INVALID";
