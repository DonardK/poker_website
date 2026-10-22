import type { BotProfile, PlayerKind, TableStatus, UserRole } from "./constants.js";

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  /** @deprecated Always false: guest accounts were retired in 2026-10. Kept for the legacy apps/server. */
  isGuest: boolean;
  role: UserRole;
  kind: PlayerKind;
  botProfile: BotProfile | null;
  bankroll: number;
  avatarHue: number;
  /**
   * Account security, sent by login, register, MFA and passkey sign-in and /me
   * (not by refresh: keep the last value). Undefined means unknown: show no
   * banner or prompt.
   */
  emailVerified?: boolean;
  /** TOTP (authenticator app) is enabled. */
  twoFactorEnabled?: boolean;
  /** Active (not removed) passkeys. */
  passkeyCount?: number;
  /**
   * The terms version this account last accepted (null: never). The edge sends
   * it on every user record; when it is not the current version the web asks
   * for acceptance (POST /api/auth/terms/accept) before anything else.
   * Undefined (an older API) shows no prompt.
   */
  termsVersion?: string | null;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
}

export interface CreateTableRequest {
  name?: string;
  maxSeats?: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  /** Legacy clients may send zero. New tables never create bots. */
  botCount?: 0;
}

export interface TableListItem {
  id: string;
  isSeated: boolean;
  name: string;
  status: TableStatus;
  maxSeats: number;
  occupiedSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  botCount: number;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  acceptTerms: true;
  confirmAge: true;
  termsVersion: string;
  /** "Keep me signed in". Default true; false gives a browser-session cookie (12 h idle, 24 h absolute). */
  remember?: boolean;
  turnstileToken?: string;
}

/** POST /api/auth/terms/accept (Bearer): an existing account accepts the current terms. 200 `{ user }`. */
export interface AcceptTermsRequest {
  acceptTerms: true;
  confirmAge: true;
  termsVersion: string;
}

/** POST /api/auth/login. Every failure answers the same 401 body (no account enumeration). */
export interface LoginRequest {
  /** A username or an email address (usernames never contain "@"), at most LOGIN_IDENTIFIER_MAX_LENGTH characters. */
  identifier: string;
  password: string;
  /** "Keep me signed in". Default true. */
  remember?: boolean;
  turnstileToken?: string;
  /** @deprecated Sent by old clients; read as the identifier when `identifier` is absent. */
  username?: string;
}
