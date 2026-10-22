// Browser-only account fixtures: the edge API's sign-in, recovery, step-up and account routes
// (docs/cloudflare/ARCHITECTURE.md §5.2; design-auth §7), in memory. Bodies, status codes and error
// codes follow the edge. Passkeys are checked for the challenge and a known credential id only (no
// signature verification: this covers the UI, the edge vitest suite covers the cryptography).
import { randomBytes, randomUUID } from 'node:crypto';
import { currentStep, matchTotp, randomBase32 } from './totp.mjs';

export const TERMS_VERSION = '2026-10-19';
export const FIXED_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const STEP_UP_WINDOW_MS = 5 * 60_000;
const TICKET_MS = 5 * 60_000;
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
const BACKUP_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A password the fixture treats as found in a data breach (the edge asks HIBP). */
export const BREACHED_PASSWORD = 'violet-kettle-breach-9183';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

function backupCode() {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (byte) => BACKUP_ALPHABET[byte % 32]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
const normalizeBackup = (code) => String(code).toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

function bearer(req) {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

/** The RP ID a browser at this Origin can use (the edge's is configured; this follows the test page). */
function rpIdOf(req) {
  try { return new URL(req.headers.origin ?? 'http://localhost').hostname; } catch { return 'localhost'; }
}

function clientData(credential) {
  try {
    return JSON.parse(Buffer.from(credential?.response?.clientDataJSON ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function createAuthFixture({ heroId, heroBankroll }) {
  /** @type {Map<string, any>} */
  const accounts = new Map();
  let currentId = heroId;
  let token = 'browser-fixture-token';
  let signInSerial = 0;
  let userSerial = 0;
  let passkeySerial = 0;
  let stepUp = { at: now(), methods: ['pwd'] };
  let flags = {};
  let requests = [];
  let otherSessions = [];
  let devices = [];
  const tickets = new Map();
  const challenges = new Map();
  const emailTokens = new Map();

  function addAccount(input) {
    const account = {
      id: input.id ?? `fixture-user-${++userSerial}`,
      username: input.username,
      email: input.email ?? `${input.username.toLowerCase()}@example.test`,
      password: input.password ?? 'correct-horse-battery',
      emailVerified: input.emailVerified ?? true,
      avatarHue: input.avatarHue ?? (userSerial * 47) % 360,
      bankroll: 10_000,
      totp: null,
      totpPending: null,
      backupCodes: [],
      passkeys: [],
      webauthnUserId: b64url(randomBytes(32)),
      passwordResetRequired: false,
      // The terms version the account last accepted (null: never), as the edge reports it on every user record.
      termsVersion: input.termsVersion === undefined ? TERMS_VERSION : input.termsVersion,
      passwordChangedAt: iso(now() - 30 * 86_400_000),
      pendingEmail: null,
      events: [],
      mfaFails: 0,
    };
    if (input.totp) {
      account.totp = { secret: input.totpSecret ?? randomBase32(32), enabledAt: iso(now()), lastStep: 0 };
      account.backupCodes = (input.backupCodes ?? Array.from({ length: 10 }, backupCode)).map((code) => ({ code: normalizeBackup(code), used: false }));
    }
    accounts.set(account.id, account);
    return account;
  }

  function reset({ signedOut = false } = {}) {
    accounts.clear();
    userSerial = 0;
    passkeySerial = 0;
    addAccount({ id: heroId, username: 'Player-0', email: 'player0@example.test', password: 'fixture-password-0', avatarHue: 0 });
    addAccount({ id: 'fixture-player-1', username: 'Player-1', email: 'player1@example.test', password: 'fixture-password-1', avatarHue: 90 });
    currentId = signedOut ? null : heroId;
    token = 'browser-fixture-token';
    signInSerial = 0;
    stepUp = { at: now(), methods: ['pwd'] };
    flags = {};
    requests = [];
    tickets.clear();
    challenges.clear();
    emailTokens.clear();
    otherSessions = [{
      id: 'session-other-1', createdAt: iso(now() - 3 * 86_400_000), lastUsedAt: iso(now() - 2 * 3_600_000),
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ip: '203.0.113.0/24', current: false,
    }];
    devices = [
      { id: 'device-this', label: 'Chrome on Windows', country: 'MT', ip: '127.0.0.0/24', firstSeenAt: iso(now() - 10 * 86_400_000), lastSeenAt: iso(now()), current: true },
      { id: 'device-phone', label: 'Safari on iOS', country: 'MT', ip: '203.0.113.0/24', firstSeenAt: iso(now() - 3 * 86_400_000), lastSeenAt: iso(now() - 2 * 3_600_000), current: false },
    ];
  }
  reset();

  const current = () => (currentId ? accounts.get(currentId) ?? null : null);
  const byName = (name) => [...accounts.values()].find((a) => a.username.toLowerCase() === String(name).toLowerCase()) ?? null;
  const byEmail = (email) => [...accounts.values()].find((a) => a.email?.toLowerCase() === String(email).toLowerCase()) ?? null;
  const bankrollOf = (account) => (account.id === heroId ? heroBankroll() : account.bankroll);

  /** PublicUser; `extras` adds the security facts login, register, MFA, passkey sign-in and /me send (refresh does not). */
  function view(account, extras = false) {
    const user = {
      id: account.id, username: account.username, email: account.email, isGuest: false, role: 'PLAYER', kind: 'HUMAN',
      botProfile: null, bankroll: bankrollOf(account), avatarHue: account.avatarHue, termsVersion: account.termsVersion,
    };
    if (!extras) return user;
    return { ...user, emailVerified: account.emailVerified, twoFactorEnabled: Boolean(account.totp), passkeyCount: account.passkeys.length };
  }

  function event(account, type, req, data = {}) {
    account.events.unshift({
      id: `event-${randomUUID()}`, type, createdAt: iso(now()), ip: '127.0.0.0/24', country: 'MT',
      userAgent: req?.headers['user-agent'] ?? null, data,
    });
  }

  function cookies(res, list) {
    const existing = res.getHeader('Set-Cookie');
    const before = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
    res.setHeader('Set-Cookie', [...before, ...list]);
  }
  /** The hint cookie (Path=/, HttpOnly, SameSite=Lax), as the API sets it beside the refresh cookie. */
  function hintCookie(res, remember = true) {
    if (flags.noHint) return;
    cookies(res, [`poker_session_hint=1; Path=/; HttpOnly; SameSite=Lax${remember ? '; Max-Age=2592000' : ''}`]);
  }
  function clearCookies(res) {
    cookies(res, ['fixture_refresh=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax', 'poker_session_hint=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
  }

  /** A new session: the old one in this browser is gone (the API revokes a refresh cookie presented with a sign-in). */
  function signIn(res, account, remember, amr, req, status = 200) {
    currentId = account.id;
    token = `browser-fixture-token-s${++signInSerial}`;
    stepUp = { at: now(), methods: amr };
    account.mfaFails = 0;
    cookies(res, [`fixture_refresh=${randomUUID()}; Path=/; HttpOnly; SameSite=Lax${remember ? '; Max-Age=2592000' : ''}`]);
    hintCookie(res, remember);
    event(account, 'SIGN_IN', req, { amr });
    onSignIn?.();
    res.status(status).json({ user: view(account, true), accessToken: token });
  }
  let onSignIn = null;

  function signOutHere() {
    currentId = null;
  }

  function turnstileFailed(req, res) {
    const value = req.body?.turnstileToken;
    if (flags.turnstileFail || typeof value !== 'string' || !value.startsWith('stub-token-')) {
      flags.turnstileFail = false;
      res.status(403).json({ error: 'Browser check failed. Try again.', code: 'TURNSTILE_FAILED' });
      return true;
    }
    return false;
  }

  /** A queued answer for the next request to `path` (`/__test/auth { nextError: { path, status, json, headers? } }`). */
  function injected(req, res) {
    const next = flags.nextError;
    if (!next || next.path !== req.path) return false;
    flags.nextError = null;
    for (const [name, value] of Object.entries(next.headers ?? {})) res.setHeader(name, value);
    res.status(next.status).json(next.json);
    return true;
  }

  function authed(req, res) {
    const account = current();
    if (!bearer(req) || !account) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return account;
  }

  function reauthRequired(res, account, needs) {
    res.status(403).json({
      error: "Please confirm it's you", code: 'REAUTH_REQUIRED',
      methods: ['password', ...(account.passkeys.length > 0 && needs !== 'password' ? ['passkey'] : [])],
      ...(needs ? { needs } : {}),
    });
  }
  /** As requireStepUp: a fresh window, with the password or a second factor where the action needs it. */
  function stepUpRefused(res, account, opts = {}) {
    const fresh = !flags.reauthRequired && now() - stepUp.at <= STEP_UP_WINDOW_MS;
    if (!fresh) { reauthRequired(res, account); return true; }
    if (opts.needPassword && !stepUp.methods.includes('pwd')) { reauthRequired(res, account, 'password'); return true; }
    if (account.totp && !stepUp.methods.some((m) => m === 'otp' || m === 'backup' || m === 'passkey')) {
      reauthRequired(res, account, 'second_factor');
      return true;
    }
    return false;
  }
  function openWindow(methods) {
    flags.reauthRequired = false;
    stepUp = { at: now(), methods };
    return { reauthenticatedUntil: iso(now() + STEP_UP_WINDOW_MS) };
  }

  function issueTicket(account, purpose, remember) {
    const ticket = `mfa-${randomUUID()}`;
    const expiresAt = now() + TICKET_MS;
    tickets.set(ticket, { userId: account.id, purpose, remember, expiresAt, used: false });
    return { mfaRequired: true, mfaTicket: ticket, methods: ['totp', 'backup_code'], expiresAt: iso(expiresAt) };
  }

  /** TOTP (±1 step, never a step already used) or an unused backup code. */
  function secondFactor(account, method, code) {
    if (!account.totp) return null;
    if (method === 'totp') {
      const step = matchTotp(account.totp.secret, String(code));
      if (step === null || step <= account.totp.lastStep) return null;
      account.totp.lastStep = step;
      return 'otp';
    }
    if (method === 'backup_code') {
      const row = account.backupCodes.find((c) => !c.used && c.code === normalizeBackup(code));
      if (!row) return null;
      row.used = true;
      return 'backup';
    }
    return null;
  }

  function verifyCode(req, res, account, method, code) {
    if (account.mfaFails >= 5) {
      res.setHeader('Retry-After', '30');
      res.status(429).json({ error: 'Too many wrong codes. Try again later.', code: 'MFA_LOCKED' });
      return null;
    }
    const amr = secondFactor(account, method, code);
    if (!amr) {
      account.mfaFails++;
      res.status(401).json({ error: 'Invalid code', code: 'MFA_INVALID' });
      return null;
    }
    account.mfaFails = 0;
    return amr;
  }

  function newChallenge(purpose, extra = {}) {
    const challenge = b64url(randomBytes(32));
    const challengeToken = `challenge-${randomUUID()}`;
    challenges.set(challengeToken, { challenge, purpose, used: false, ...extra });
    return { challenge, challengeToken };
  }
  /** The stored challenge for a token, if this credential's client data answers it (type and challenge). */
  function takeChallenge(challengeToken, purpose, credential, type) {
    const entry = challenges.get(challengeToken);
    if (!entry || entry.used || entry.purpose !== purpose) return { error: 'challenge' };
    const data = clientData(credential);
    if (!data || data.type !== type || data.challenge !== entry.challenge) return { error: 'credential' };
    entry.used = true;
    return { entry };
  }
  const findPasskey = (credentialId) => {
    for (const account of accounts.values()) {
      const passkey = account.passkeys.find((p) => p.credentialId === credentialId);
      if (passkey) return { account, passkey };
    }
    return null;
  };
  const summary = ({ id, name, createdAt, lastUsedAt, backedUp, deviceType, transports }) => ({ id, name, createdAt, lastUsedAt, backedUp, deviceType, transports });

  function emailToken(kind, account, extra = {}) {
    const value = b64url(randomBytes(32));
    // email: the address the link went to (EMAIL_CHANGE: the new one, from extra); previousEmail: the account's address then.
    emailTokens.set(value, { kind, userId: account.id, email: account.email, previousEmail: account.email, used: false, expiresAt: now() + 30 * 60_000, ...extra });
    return value;
  }
  function takeEmailToken(value, kinds) {
    const entry = emailTokens.get(String(value));
    if (!entry || entry.used || entry.expiresAt <= now() || !kinds.includes(entry.kind)) return null;
    return entry;
  }

  function passwordProblem(res, password, username) {
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) {
      res.status(400).json({ error: 'Invalid request payload' });
      return true;
    }
    if (username && password.toLowerCase().includes(username.toLowerCase())) {
      res.status(400).json({ error: "Choose a password that doesn't contain your username.", code: 'PASSWORD_WEAK' });
      return true;
    }
    if (password === BREACHED_PASSWORD) {
      res.status(400).json({ error: "This password has appeared in a data breach, so it isn't safe to use. Choose a different one.", code: 'PASSWORD_BREACHED' });
      return true;
    }
    return false;
  }

  function security(account) {
    return {
      email: account.email,
      emailVerified: account.emailVerified,
      pendingEmail: account.pendingEmail,
      passwordChangedAt: account.passwordChangedAt,
      totp: {
        enabled: Boolean(account.totp),
        enabledAt: account.totp?.enabledAt ?? null,
        backupCodesRemaining: account.totp ? account.backupCodes.filter((c) => !c.used).length : 0,
      },
      passkeys: account.passkeys.map(summary),
      stepUpUntil: now() - stepUp.at <= STEP_UP_WINDOW_MS ? iso(stepUp.at + STEP_UP_WINDOW_MS) : null,
      securityHoldUntil: null,
      capabilities: { email: true, passkeys: true, totp: true },
    };
  }

  function install(app) {
    // Every API call, for specs that check what was (and was not) sent: e.g. no token in a URL, no POST on page load.
    app.use((req, _res, next) => {
      if (req.path.startsWith('/api/')) requests.push({ method: req.method, path: req.path, url: req.originalUrl, body: req.body ?? null });
      next();
    });
    app.use((req, res, next) => (injected(req, res) ? undefined : next()));

    app.get('/api/auth/config', (_req, res) => res.json({
      termsVersion: TERMS_VERSION, emailEnabled: true, passkeysEnabled: !flags.passkeysOff, totpEnabled: true,
      stepUpWindowMs: STEP_UP_WINDOW_MS, passwordMinLength: 12, breachCheck: true,
    }));

    // Gone: guest play was retired (the edge answers 404 now).
    app.post('/api/auth/guest', (_req, res) => res.status(404).json({ error: 'Not found' }));

    app.post('/api/auth/register', (req, res) => {
      if (turnstileFailed(req, res)) return;
      const body = req.body ?? {};
      if (body.acceptTerms !== true || body.confirmAge !== true || typeof body.termsVersion !== 'string') {
        res.status(400).json({ error: 'Please accept the terms and confirm you are 18 or older', code: 'TERMS_REQUIRED' });
        return;
      }
      if (body.termsVersion !== TERMS_VERSION) {
        res.status(409).json({ error: 'The terms have been updated; please review and accept the current version', code: 'TERMS_OUTDATED', currentVersion: TERMS_VERSION });
        return;
      }
      if (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || typeof body.password !== 'string') {
        res.status(400).json({ error: 'Invalid registration payload' });
        return;
      }
      if (typeof body.username !== 'string' || !USERNAME.test(body.username)) {
        res.status(400).json({ error: 'Usernames are 3-24 characters: letters, digits and underscores' });
        return;
      }
      if (passwordProblem(res, body.password, body.username)) return;
      if (byName(body.username) || /^(guest_|bot_|admin)/i.test(body.username)) { res.status(409).json({ error: 'Username unavailable' }); return; }
      if (byEmail(body.email)) { res.status(409).json({ error: 'Registration could not be completed with these details' }); return; }
      const account = addAccount({ username: body.username, email: body.email.toLowerCase(), password: body.password, emailVerified: false });
      account.passwordChangedAt = iso(now());
      emailToken('VERIFY_EMAIL', account);
      signIn(res, account, body.remember !== false, ['pwd'], req, 201);
    });

    app.post('/api/auth/login', (req, res) => {
      if (turnstileFailed(req, res)) return;
      const body = req.body ?? {};
      const identifier = typeof body.identifier === 'string' ? body.identifier : body.username;
      if (typeof identifier !== 'string' || !identifier || typeof body.password !== 'string' || !body.password) {
        res.status(400).json({ error: 'Invalid login payload' });
        return;
      }
      const trimmed = identifier.trim();
      const account = trimmed.includes('@') ? byEmail(trimmed) : byName(trimmed);
      if (!account || account.password !== body.password) { res.status(401).json({ error: 'Invalid credentials' }); return; }
      if (account.passwordResetRequired) {
        res.status(403).json({ error: 'For your security, reset your password before signing in.', code: 'PASSWORD_RESET_REQUIRED' });
        return;
      }
      const remember = body.remember !== false;
      if (account.totp) { res.json(issueTicket(account, 'login', remember)); return; }
      signIn(res, account, remember, ['pwd'], req);
    });

    app.post('/api/auth/login/mfa', (req, res) => {
      const body = req.body ?? {};
      const entry = tickets.get(body.mfaTicket);
      const account = entry ? accounts.get(entry.userId) : null;
      if (!entry || !account || entry.used || entry.purpose !== 'login' || entry.expiresAt <= now() || flags.expireTickets) {
        res.status(401).json({ error: 'Sign-in expired. Start again.', code: 'MFA_TICKET_INVALID' });
        return;
      }
      const amr = verifyCode(req, res, account, body.method, body.code);
      if (!amr) return;
      entry.used = true;
      signIn(res, account, typeof body.remember === 'boolean' ? body.remember : entry.remember, ['pwd', amr], req);
    });

    app.post('/api/auth/passkey/options', (req, res) => {
      if (flags.passkeysOff) { res.status(503).json({ error: 'Passkeys are not available right now.', code: 'PASSKEYS_UNAVAILABLE', retryable: false }); return; }
      const { challenge, challengeToken } = newChallenge('login');
      res.json({ options: { challenge, rpId: rpIdOf(req), timeout: 120_000, userVerification: 'required', allowCredentials: [] }, challengeToken });
    });

    app.post('/api/auth/passkey/login', (req, res) => {
      const body = req.body ?? {};
      const taken = takeChallenge(body.challengeToken, 'login', body.credential, 'webauthn.get');
      if (taken.error === 'challenge') { res.status(400).json({ error: 'Passkey request expired. Try again.', code: 'CHALLENGE_INVALID' }); return; }
      const found = taken.error ? null : findPasskey(body.credential?.id);
      const handle = body.credential?.response?.userHandle;
      if (!found || (handle && handle !== found.account.webauthnUserId)) {
        res.status(401).json({ error: 'Passkey not recognised', code: 'PASSKEY_INVALID' });
        return;
      }
      found.passkey.lastUsedAt = iso(now());
      signIn(res, found.account, body.remember !== false, ['passkey'], req);
    });

    app.post('/api/auth/logout', (_req, res) => {
      signOutHere();
      clearCookies(res);
      res.status(204).end();
    });

    app.post('/api/auth/password/forgot', (req, res) => {
      if (turnstileFailed(req, res)) return;
      const email = req.body?.email;
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { res.status(400).json({ error: 'Invalid request payload' }); return; }
      const account = byEmail(email.trim());
      if (account) emailToken('PASSWORD_RESET', account);
      // The same answer whether or not the address has an account.
      res.status(202).json({ ok: true });
    });

    app.post('/api/auth/password/reset', (req, res) => {
      const body = req.body ?? {};
      const entry = takeEmailToken(body.token, ['PASSWORD_RESET']);
      const account = entry ? accounts.get(entry.userId) : null;
      if (!entry || !account) { res.status(400).json({ error: 'This link is invalid or has expired.', code: 'TOKEN_INVALID' }); return; }
      // Checked before the token is spent: a weak password does not burn the link.
      if (passwordProblem(res, body.newPassword, account.username)) return;
      entry.used = true;
      account.password = body.newPassword;
      account.passwordResetRequired = false;
      account.passwordChangedAt = iso(now());
      if (account.email === entry.email) account.emailVerified = true;
      event(account, 'PASSWORD_RESET', req);
      if (currentId === account.id) signOutHere();
      clearCookies(res);
      res.status(204).end();
    });

    // Verification links only (an email change is confirmed on its own route, as on the edge).
    app.post('/api/auth/email/verify', (req, res) => {
      const entry = takeEmailToken(req.body?.token, ['VERIFY_EMAIL']);
      const account = entry ? accounts.get(entry.userId) : null;
      if (!entry || !account) { res.status(400).json({ error: 'This link is invalid or has expired.', code: 'TOKEN_INVALID' }); return; }
      // A link for an address the account no longer uses proves nothing (the edge refuses it in the same transaction).
      if (account.email !== entry.email) { res.status(400).json({ error: 'This link is invalid or has expired.', code: 'TOKEN_INVALID' }); return; }
      entry.used = true;
      if (!account.emailVerified) event(account, 'EMAIL_VERIFIED', req);
      account.emailVerified = true;
      res.json({ emailVerified: true });
    });

    app.post('/api/auth/email/change/confirm', (req, res) => {
      const entry = takeEmailToken(req.body?.token, ['EMAIL_CHANGE']);
      const account = entry ? accounts.get(entry.userId) : null;
      if (!entry || !account) { res.status(400).json({ error: 'This link is invalid or has expired.', code: 'TOKEN_INVALID' }); return; }
      // The address changed again since the link was sent: the link is stale. Refusals leave the token unspent (one transaction on the edge).
      if (account.email !== entry.previousEmail) { res.status(400).json({ error: 'This link is invalid or has expired.', code: 'TOKEN_INVALID' }); return; }
      const taken = byEmail(entry.email);
      if (taken && taken.id !== account.id) { res.status(409).json({ error: "This email can't be used.", code: 'EMAIL_UNAVAILABLE' }); return; }
      account.email = entry.email;
      account.emailVerified = true;
      account.pendingEmail = null;
      for (const other of emailTokens.values()) {
        if (other.userId === account.id && (other.kind === 'EMAIL_CHANGE' || other.kind === 'VERIFY_EMAIL')) other.used = true;
      }
      event(account, 'EMAIL_CHANGED', req);
      res.json({ email: account.email });
    });

    app.post('/api/auth/security/lockdown', (req, res) => {
      const entry = takeEmailToken(req.body?.token, ['SECURITY_LOCKDOWN']);
      const account = entry ? accounts.get(entry.userId) : null;
      if (!entry || !account) { res.status(400).json({ error: 'This link is invalid or has expired.', code: 'TOKEN_INVALID' }); return; }
      entry.used = true;
      account.passwordResetRequired = true;
      otherSessions = [];
      if (currentId === account.id) signOutHere();
      event(account, 'NOT_ME_REPORTED', req);
      const resetToken = emailToken('PASSWORD_RESET', account, { issuedBy: 'lockdown' });
      clearCookies(res);
      res.json({ secured: true, resetToken, expiresAt: iso(now() + 30 * 60_000) });
    });

    // An existing account accepts the current terms (same checks and bodies as registration).
    app.post('/api/auth/terms/accept', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      const body = req.body ?? {};
      if (body.acceptTerms !== true || body.confirmAge !== true || typeof body.termsVersion !== 'string') {
        res.status(400).json({ error: 'Please accept the terms and confirm you are 18 or older', code: 'TERMS_REQUIRED' });
        return;
      }
      if (body.termsVersion !== TERMS_VERSION) {
        res.status(409).json({ error: 'The terms have been updated; please review and accept the current version', code: 'TERMS_OUTDATED', currentVersion: TERMS_VERSION });
        return;
      }
      account.termsVersion = TERMS_VERSION;
      res.json({ user: view(account, true) });
    });

    // Step-up for account changes.
    app.post('/api/auth/reauth/password', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      if (req.body?.password !== account.password) { res.status(401).json({ error: 'Invalid credentials' }); return; }
      if (account.totp) { res.json(issueTicket(account, 'reauth', true)); return; }
      res.json(openWindow(['pwd']));
    });
    app.post('/api/auth/reauth/mfa', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      const entry = tickets.get(req.body?.mfaTicket);
      if (!entry || entry.used || entry.purpose !== 'reauth' || entry.userId !== account.id || entry.expiresAt <= now()) {
        res.status(401).json({ error: 'Confirmation expired. Start again.', code: 'MFA_TICKET_INVALID' });
        return;
      }
      const amr = verifyCode(req, res, account, req.body?.method, req.body?.code);
      if (!amr) return;
      entry.used = true;
      res.json(openWindow(['pwd', amr]));
    });
    app.post('/api/auth/reauth/passkey/options', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      if (account.passkeys.length === 0) { res.status(409).json({ error: 'This account has no passkeys.', code: 'NO_PASSKEYS' }); return; }
      const { challenge, challengeToken } = newChallenge('reauth', { userId: account.id });
      res.json({
        options: {
          challenge, rpId: rpIdOf(req), timeout: 120_000, userVerification: 'required',
          allowCredentials: account.passkeys.map((p) => ({ id: p.credentialId, type: 'public-key', transports: p.transports })),
        },
        challengeToken,
      });
    });
    app.post('/api/auth/reauth/passkey', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      const taken = takeChallenge(req.body?.challengeToken, 'reauth', req.body?.credential, 'webauthn.get');
      if (taken.error === 'challenge' || (taken.entry && taken.entry.userId !== account.id)) {
        res.status(400).json({ error: 'Passkey request expired. Try again.', code: 'CHALLENGE_INVALID' });
        return;
      }
      const found = taken.error ? null : findPasskey(req.body?.credential?.id);
      if (!found || found.account.id !== account.id) { res.status(401).json({ error: 'Passkey not recognised', code: 'PASSKEY_INVALID' }); return; }
      found.passkey.lastUsedAt = iso(now());
      res.json(openWindow(['passkey']));
    });

    // Sessions (existing edge routes).
    app.get('/api/auth/sessions', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      res.json({
        sessions: [
          { id: 'session-current', createdAt: iso(stepUp.at), lastUsedAt: iso(now()), userAgent: req.headers['user-agent'] ?? null, ip: '127.0.0.0/24', current: true },
          ...otherSessions,
        ],
      });
    });
    app.delete('/api/auth/sessions/:id', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      if (req.params.id === 'session-current') { signOutHere(); clearCookies(res); res.status(204).end(); return; }
      const before = otherSessions.length;
      otherSessions = otherSessions.filter((s) => s.id !== req.params.id);
      if (otherSessions.length === before) { res.status(404).json({ error: 'Session not found' }); return; }
      res.status(204).end();
    });
    app.post('/api/auth/logout-all', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      const exceptCurrent = req.body?.exceptCurrent === true;
      const revoked = otherSessions.length + (exceptCurrent ? 0 : 1);
      otherSessions = [];
      event(account, 'LOGOUT_ALL', req, { revoked, exceptCurrent });
      if (!exceptCurrent) { signOutHere(); clearCookies(res); }
      res.json({ revoked });
    });

    // The account security page.
    app.get('/api/account/security', (req, res) => {
      const account = authed(req, res);
      if (account) res.json(security(account));
    });
    app.get('/api/account/events', (req, res) => {
      const account = authed(req, res);
      if (account) res.json({ events: account.events.slice(0, Math.min(50, Number(req.query.limit) || 20)), next: null });
    });
    app.get('/api/account/devices', (req, res) => {
      const account = authed(req, res);
      if (account) res.json({ devices });
    });
    app.delete('/api/account/devices/:id', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      const device = devices.find((d) => d.id === req.params.id);
      if (!device) { res.status(404).json({ error: 'Device not found' }); return; }
      devices = devices.filter((d) => d !== device);
      if (device.current) { signOutHere(); clearCookies(res); }
      res.status(204).end();
    });
    app.post('/api/account/password', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account, { needPassword: true })) return;
      if (passwordProblem(res, req.body?.newPassword, account.username)) return;
      account.password = req.body.newPassword;
      account.passwordChangedAt = iso(now());
      const revokedSessions = otherSessions.length;
      otherSessions = [];
      event(account, 'PASSWORD_CHANGED', req);
      res.json({ revokedSessions });
    });
    app.post('/api/account/email', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account)) return;
      const email = String(req.body?.newEmail ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'Invalid request payload' }); return; }
      if (email === account.email && account.emailVerified) { res.status(409).json({ error: 'This email is already confirmed.', code: 'EMAIL_ALREADY_VERIFIED' }); return; }
      account.pendingEmail = email;
      emailToken('EMAIL_CHANGE', account, { email });
      res.status(202).json({ ok: true, pendingEmail: email });
    });
    app.post('/api/account/email/verification', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      if (account.emailVerified) { res.status(409).json({ error: 'This email is already confirmed.', code: 'EMAIL_ALREADY_VERIFIED' }); return; }
      emailToken('VERIFY_EMAIL', account);
      res.status(202).json({ ok: true });
    });

    app.post('/api/account/2fa/totp/setup', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account)) return;
      if (account.totp) { res.status(409).json({ error: 'Two-step verification is already on.', code: 'TOTP_ALREADY_ENABLED' }); return; }
      const secret = flags.randomTotp ? randomBase32(32) : FIXED_TOTP_SECRET;
      const expiresAt = now() + 15 * 60_000;
      account.totpPending = { secret, expiresAt };
      const label = `${encodeURIComponent("Hold'em Live")}:${encodeURIComponent(account.username)}`;
      res.json({
        secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("Hold'em Live")}&algorithm=SHA1&digits=6&period=30`,
        expiresAt: iso(expiresAt),
      });
    });
    app.post('/api/account/2fa/totp/enable', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      const pending = account.totpPending;
      if (account.totp || !pending || pending.expiresAt <= now() || flags.expireTotpSetup) {
        flags.expireTotpSetup = false;
        res.status(409).json({ error: 'Start the setup again.', code: 'TOTP_NOT_PENDING' });
        return;
      }
      const step = matchTotp(pending.secret, String(req.body?.code ?? ''));
      if (step === null) { res.status(400).json({ error: "That code didn't match. Check your phone's time and try again.", code: 'TOTP_INVALID' }); return; }
      account.totp = { secret: pending.secret, enabledAt: iso(now()), lastStep: step };
      account.totpPending = null;
      const codes = Array.from({ length: 10 }, backupCode);
      account.backupCodes = codes.map((code) => ({ code: normalizeBackup(code), used: false }));
      stepUp.methods = [...new Set([...stepUp.methods, 'otp'])];
      event(account, 'TOTP_ENABLED', req);
      res.json({ backupCodes: codes });
    });
    app.delete('/api/account/2fa/totp', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account)) return;
      if (!account.totp) { res.status(409).json({ error: 'Two-step verification is off.', code: 'TOTP_NOT_ENABLED' }); return; }
      account.totp = null;
      event(account, 'TOTP_DISABLED', req);
      res.status(204).end();
    });
    app.post('/api/account/2fa/backup-codes', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account)) return;
      if (!account.totp) { res.status(409).json({ error: 'Two-step verification is off.', code: 'TOTP_NOT_ENABLED' }); return; }
      const codes = Array.from({ length: 10 }, backupCode);
      account.backupCodes = codes.map((code) => ({ code: normalizeBackup(code), used: false }));
      event(account, 'BACKUP_CODES_REGENERATED', req);
      res.json({ backupCodes: codes });
    });

    app.get('/api/account/passkeys', (req, res) => {
      const account = authed(req, res);
      if (account) res.json({ passkeys: account.passkeys.map(summary) });
    });
    app.post('/api/account/passkeys/options', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account)) return;
      const { challenge, challengeToken } = newChallenge('register', { userId: account.id });
      res.json({
        options: {
          rp: { name: "Hold'em Live", id: rpIdOf(req) },
          user: { id: account.webauthnUserId, name: account.username, displayName: account.username },
          challenge,
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          timeout: 120_000,
          attestation: 'none',
          excludeCredentials: account.passkeys.map((p) => ({ id: p.credentialId, type: 'public-key', transports: p.transports })),
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        },
        challengeToken,
      });
    });
    app.post('/api/account/passkeys', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account)) return;
      const body = req.body ?? {};
      const taken = takeChallenge(body.challengeToken, 'register', body.credential, 'webauthn.create');
      if (taken.error === 'challenge' || (taken.entry && taken.entry.userId !== account.id)) {
        res.status(400).json({ error: 'Passkey request expired. Try again.', code: 'CHALLENGE_INVALID' });
        return;
      }
      if (taken.error) { res.status(400).json({ error: "The passkey couldn't be verified.", code: 'PASSKEY_INVALID' }); return; }
      if (findPasskey(body.credential.id)) { res.status(409).json({ error: 'This passkey is already registered.', code: 'PASSKEY_ALREADY_REGISTERED' }); return; }
      const passkey = {
        id: `passkey-${++passkeySerial}`, credentialId: body.credential.id,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : 'Passkey',
        createdAt: iso(now()), lastUsedAt: null, backedUp: false, deviceType: 'singleDevice',
        transports: Array.isArray(body.credential.response?.transports) ? body.credential.response.transports : [],
      };
      account.passkeys.push(passkey);
      event(account, 'PASSKEY_ADDED', req);
      res.status(201).json({ passkey: summary(passkey) });
    });
    app.post('/api/account/passkeys/:id/rename', (req, res) => {
      const account = authed(req, res);
      if (!account) return;
      const passkey = account.passkeys.find((p) => p.id === req.params.id);
      const name = String(req.body?.name ?? '').trim();
      if (!passkey) { res.status(404).json({ error: 'Passkey not found' }); return; }
      if (!name || name.length > 64) { res.status(400).json({ error: 'Invalid request payload' }); return; }
      passkey.name = name;
      res.json({ passkey: summary(passkey) });
    });
    app.delete('/api/account/passkeys/:id', (req, res) => {
      const account = authed(req, res);
      if (!account || stepUpRefused(res, account)) return;
      const before = account.passkeys.length;
      account.passkeys = account.passkeys.filter((p) => p.id !== req.params.id);
      if (account.passkeys.length === before) { res.status(404).json({ error: 'Passkey not found' }); return; }
      event(account, 'PASSKEY_REMOVED', req);
      res.status(204).end();
    });

    // Test controls.
    app.post('/__test/auth', (req, res) => {
      const body = req.body ?? {};
      if (body.reset) reset({ signedOut: body.signedOut === true });
      else if (typeof body.signedOut === 'boolean') currentId = body.signedOut ? null : heroId;
      if (typeof body.as === 'string' && accounts.has(body.as)) { currentId = body.as; token = `browser-fixture-token-as-${body.as}`; }
      for (const key of ['reauthRequired', 'noHint', 'expireTickets', 'randomTotp', 'turnstileFail', 'passkeysOff', 'expireTotpSetup']) {
        if (typeof body[key] === 'boolean') flags[key] = body[key];
      }
      if (body.nextError) flags.nextError = body.nextError;
      if (body.emailVerified !== undefined && current()) current().emailVerified = body.emailVerified;
      res.json({ ok: true, currentId });
    });
    app.post('/__test/users', (req, res) => {
      const body = req.body ?? {};
      const account = addAccount({
        username: body.username, email: body.email, password: body.password, emailVerified: body.emailVerified ?? true,
        totp: body.totp === true, totpSecret: body.totpSecret, backupCodes: body.backupCodes, avatarHue: body.avatarHue,
        termsVersion: body.termsVersion,
      });
      if (body.passwordResetRequired) account.passwordResetRequired = true;
      res.json({
        id: account.id, username: account.username, email: account.email, password: account.password,
        totpSecret: account.totp?.secret ?? null,
        backupCodes: body.backupCodes ?? null,
      });
    });
    app.get('/__test/users/:username', (req, res) => {
      const account = byName(req.params.username);
      if (!account) { res.status(404).json({ error: 'no such user' }); return; }
      res.json({ ...security(account), id: account.id, password: account.password, passwordResetRequired: account.passwordResetRequired });
    });
    // A link token as an email would carry it: kind verify | reset | not-me | email-change.
    app.post('/__test/tokens', (req, res) => {
      const body = req.body ?? {};
      const account = body.username ? byName(body.username) : current() ?? accounts.get(heroId);
      if (!account) { res.status(404).json({ error: 'no such user' }); return; }
      const kind = { verify: 'VERIFY_EMAIL', reset: 'PASSWORD_RESET', 'not-me': 'SECURITY_LOCKDOWN', 'email-change': 'EMAIL_CHANGE' }[body.kind];
      if (!kind) { res.status(400).json({ error: 'unknown kind' }); return; }
      const value = emailToken(kind, account, body.email ? { email: body.email } : {});
      if (body.expired) emailTokens.get(value).expiresAt = now() - 1;
      res.json({ token: value });
    });
    app.get('/__test/requests', (_req, res) => res.json({ requests }));
  }

  return {
    install,
    reset,
    current,
    view,
    hintCookie,
    clearCookies,
    sessionToken: () => token,
    signedIn: () => currentId !== null,
    /** Called after every sign-in (the game fixture resets its refresh-cookie rotation then). */
    onSignIn(listener) { onSignIn = listener; },
    stepNow: () => currentStep(now()),
  };
}
