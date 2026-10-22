import type {
  AccountSecurity, AuthClientConfig, AuthResponse, BackupCodesResponse, ChangeEmailResponse, ChangePasswordResponse,
  EmailChangedResponse, EmailVerifiedResponse, KnownDevicesResponse, LockdownResponse, LoginResponse, MfaChallenge,
  PasskeyOptionsResponse, PasskeySummary, PasskeysResponse, PublicUser, SecondFactorMethod, SecurityEventsResponse,
  StepUpResult, TotpSetupResponse,
} from "@poker/shared";
import { api, ApiError, authedApi } from "@/lib/api";
import type { TermsAcceptance } from "@/lib/legal";

/**
 * Typed wrappers for every account endpoint the web app calls. The contract
 * is docs/cloudflare/ARCHITECTURE.md §5.2 (design-auth §7): edits are POST,
 * removals DELETE (CORS allows no PATCH), and errors are
 * `{ error, code?, ... }`, surfaced as ApiError (code, details, retryAfterMs).
 */

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Types the shared package does not define (yet)
// ---------------------------------------------------------------------------

/** One row of GET /api/auth/sessions (apps/edge/src/http/auth.ts). */
export interface AuthSessionView {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

/** WebAuthn options as the browser library reads them (a subset of the JSON shapes). */
export interface PasskeyRequestOptions { challenge: string; rpId?: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Signed out: sign-in, sign-up and recovery
// ---------------------------------------------------------------------------

export function fetchAuthConfig(): Promise<AuthClientConfig> {
  return api<AuthClientConfig>("/api/auth/config", { method: "GET" });
}

export function login(body: { identifier: string; password: string; remember: boolean; turnstileToken?: string }): Promise<LoginResponse> {
  return api<LoginResponse>("/api/auth/login", json(body));
}

export function completeMfaLogin(body: { mfaTicket: string; method: SecondFactorMethod; code: string; remember: boolean }): Promise<AuthResponse> {
  return api<AuthResponse>("/api/auth/login/mfa", json(body));
}

export function register(body: {
  username: string; email: string; password: string; remember: boolean; turnstileToken?: string;
} & TermsAcceptance): Promise<AuthResponse> {
  return api<AuthResponse>("/api/auth/register", json(body));
}

export function passkeyLoginOptions(): Promise<PasskeyOptionsResponse> {
  return api<PasskeyOptionsResponse>("/api/auth/passkey/options", json({}));
}

export function passkeyLogin(body: { challengeToken: string; credential: unknown; remember: boolean }): Promise<AuthResponse> {
  return api<AuthResponse>("/api/auth/passkey/login", json(body));
}

export function forgotPassword(body: { email: string; turnstileToken?: string }): Promise<{ ok: true }> {
  return api<{ ok: true }>("/api/auth/password/forgot", json(body));
}

export function resetPassword(body: { token: string; newPassword: string }): Promise<void> {
  return api<void>("/api/auth/password/reset", json(body));
}

/** Confirm the account's email address from a verification link (VERIFY_EMAIL tokens only). */
export function verifyEmail(token: string): Promise<EmailVerifiedResponse> {
  return api<EmailVerifiedResponse>("/api/auth/email/verify", json({ token }));
}

/** Confirm an email change from the link sent to the new address; answers the account's new address. */
export function confirmEmailChange(token: string): Promise<EmailChangedResponse> {
  return api<EmailChangedResponse>("/api/auth/email/change/confirm", json({ token }));
}

export function lockdown(token: string): Promise<LockdownResponse> {
  return api<LockdownResponse>("/api/auth/security/lockdown", json({ token }));
}

// ---------------------------------------------------------------------------
// Signed in: the session, step-up and account changes (Bearer)
// ---------------------------------------------------------------------------

export function fetchMe(): Promise<{ user: PublicUser }> {
  return authedApi<{ user: PublicUser }>("/api/auth/me", { method: "GET" });
}

export function reauthPassword(password: string): Promise<StepUpResult | MfaChallenge> {
  return authedApi<StepUpResult | MfaChallenge>("/api/auth/reauth/password", json({ password }));
}

export function reauthMfa(body: { mfaTicket: string; method: SecondFactorMethod; code: string }): Promise<StepUpResult> {
  return authedApi<StepUpResult>("/api/auth/reauth/mfa", json(body));
}

export function reauthPasskeyOptions(): Promise<PasskeyOptionsResponse> {
  return authedApi<PasskeyOptionsResponse>("/api/auth/reauth/passkey/options", json({}));
}

export function reauthPasskey(body: { challengeToken: string; credential: unknown }): Promise<StepUpResult> {
  return authedApi<StepUpResult>("/api/auth/reauth/passkey", json(body));
}

export function fetchAccountSecurity(): Promise<AccountSecurity> {
  return authedApi<AccountSecurity>("/api/account/security", { method: "GET" });
}

export function fetchSecurityEvents(limit = 20): Promise<SecurityEventsResponse> {
  return authedApi<SecurityEventsResponse>(`/api/account/events?limit=${limit}`, { method: "GET" });
}

export function fetchDevices(): Promise<KnownDevicesResponse> {
  return authedApi<KnownDevicesResponse>("/api/account/devices", { method: "GET" });
}

export function forgetDevice(id: string): Promise<void> {
  return authedApi<void>(`/api/account/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function changePassword(newPassword: string): Promise<ChangePasswordResponse> {
  return authedApi<ChangePasswordResponse>("/api/account/password", json({ newPassword }));
}

export function changeEmail(newEmail: string): Promise<ChangeEmailResponse> {
  return authedApi<ChangeEmailResponse>("/api/account/email", json({ newEmail }));
}

export function resendVerification(): Promise<{ ok: true }> {
  return authedApi<{ ok: true }>("/api/account/email/verification", json({}));
}

export function startTotpSetup(): Promise<TotpSetupResponse> {
  return authedApi<TotpSetupResponse>("/api/account/2fa/totp/setup", json({}));
}

export function enableTotp(code: string): Promise<BackupCodesResponse> {
  return authedApi<BackupCodesResponse>("/api/account/2fa/totp/enable", json({ code }));
}

export function disableTotp(): Promise<void> {
  return authedApi<void>("/api/account/2fa/totp", { method: "DELETE" });
}

export function regenerateBackupCodes(): Promise<BackupCodesResponse> {
  return authedApi<BackupCodesResponse>("/api/account/2fa/backup-codes", json({}));
}

export function fetchPasskeys(): Promise<PasskeysResponse> {
  return authedApi<PasskeysResponse>("/api/account/passkeys", { method: "GET" });
}

export function passkeyRegistrationOptions(): Promise<PasskeyOptionsResponse> {
  return authedApi<PasskeyOptionsResponse>("/api/account/passkeys/options", json({}));
}

export function registerPasskey(body: { challengeToken: string; credential: unknown; name: string }): Promise<{ passkey: PasskeySummary }> {
  return authedApi<{ passkey: PasskeySummary }>("/api/account/passkeys", json(body));
}

export function renamePasskey(id: string, name: string): Promise<{ passkey: PasskeySummary }> {
  return authedApi<{ passkey: PasskeySummary }>(`/api/account/passkeys/${encodeURIComponent(id)}/rename`, json({ name }));
}

export function removePasskey(id: string): Promise<void> {
  return authedApi<void>(`/api/account/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchSessions(): Promise<{ sessions: AuthSessionView[] }> {
  return authedApi<{ sessions: AuthSessionView[] }>("/api/auth/sessions", { method: "GET" });
}

export function revokeSession(id: string): Promise<void> {
  return authedApi<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function signOutOtherSessions(): Promise<{ revoked: number }> {
  return authedApi<{ revoked: number }>("/api/auth/logout-all", json({ exceptCurrent: true }));
}

/**
 * An existing account accepts the current terms (the terms update prompt,
 * shown while `user.termsVersion` is not this build's TERMS_VERSION). Errors
 * as at registration: 400 TERMS_REQUIRED, 409 TERMS_OUTDATED.
 */
export function acceptTerms(body: TermsAcceptance): Promise<{ user: PublicUser }> {
  return authedApi<{ user: PublicUser }>("/api/auth/terms/accept", json(body));
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export function errorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

/** Whole seconds until a 429 may be retried, or null when the error is not a rate limit. */
export function retryAfterSeconds(err: unknown, fallbackSeconds = 30): number | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  return Math.max(1, Math.ceil((err.retryAfterMs ?? fallbackSeconds * 1000) / 1000));
}

/** The API's message for an error, or a fallback for anything that is not an ApiError. */
export function messageOf(err: unknown, fallback = "Something went wrong. Try again."): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The error was a network failure or a temporary server problem: inputs are kept and the user can retry. */
export function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status === 503 || err.retryable);
}
