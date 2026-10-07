/**
 * In-memory stand-in for the Prisma delegates the auth layer uses (User,
 * Session, plus the seat/table reads made when a socket connects). No real
 * database is touched: run-tests.mjs points DATABASE_URL at a dead port, and
 * every delegate method used here is replaced for the duration of a test.
 *
 * Outages are injected per call site: `db.down = true` makes every call fail
 * the way an unreachable database does; `db.fail('session.findUnique', n)`
 * fails the next n calls of one method. `db.hold(key, n)` parks the first n
 * calls of a method until all n have arrived (forces a race deterministically).
 */
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../dist/db/prisma.js';
import { signAccessToken, signRefreshToken } from '../../dist/auth/jwt.js';
import { clearAuthCache } from '../../dist/auth/sessions.js';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** What Prisma throws when the database cannot be reached. */
export const outage = () => Object.assign(new Error("Can't reach database server at 127.0.0.1:5432"), { name: 'PrismaClientInitializationError' });
export const uniqueViolation = (target) => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target } });

const DAY = 86_400_000;

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond === null) return value == null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      if ('not' in cond) return value !== cond.not;
      if ('in' in cond) return cond.in.includes(value);
      if ('gt' in cond) return value != null && value > cond.gt;
      if ('gte' in cond) return value != null && value >= cond.gte;
    }
    return value === cond;
  });
}
const pick = (row, select) => select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, structuredClone(row[k])])) : structuredClone(row);
function apply(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) row[key] += value.increment;
    else if (value && typeof value === 'object' && !(value instanceof Date) && 'decrement' in value) row[key] -= value.decrement;
    else row[key] = value;
  }
  row.updatedAt = new Date();
}

export function fakeAuthDb(t) {
  let state = { users: new Map(), sessions: new Map(), seats: new Map(), tables: new Map() };
  const failures = new Map();
  const holds = new Map();
  const createHooks = [];
  const db = {
    down: false,
    calls: {},
    fail(key, times = 1) { failures.set(key, (failures.get(key) ?? 0) + times); },
    hold(key, count) { holds.set(key, { count, waiting: [] }); },
    /** Run `hook(data)` before every user.create; it may throw (e.g. a unique violation). */
    onUserCreate(hook) { createHooks.push(hook); },
    get users() { return state.users; },
    get sessions() { return state.sessions; },
    user: (id) => state.users.get(id),
    session: (id) => state.sessions.get(id),
    userByName: (username) => [...state.users.values()].find((u) => u.username === username),
    sessionsOf: (userId) => [...state.sessions.values()].filter((s) => s.userId === userId),
    addUser(overrides = {}) {
      const username = overrides.username ?? `Player_${state.users.size + 1}`;
      const { password, ...rest } = overrides;
      const user = {
        id: `user-${randomUUID()}`, email: null, passwordHash: password ? bcrypt.hashSync(password, 4) : null, isGuest: false, role: 'PLAYER', kind: 'HUMAN',
        botProfile: null, bankroll: 10_000, avatarHue: 0, createdAt: new Date(), updatedAt: new Date(), lastSeenAt: null,
        failedLoginCount: 0, lockedUntil: null, termsVersion: null, termsAcceptedAt: null, ageConfirmedAt: null,
        ...rest, username, usernameCanonical: username.toLowerCase(),
      };
      state.users.set(user.id, user);
      return user;
    },
    /** A live session row plus its tokens (as issued at sign-in). */
    addSession(userId, overrides = {}) {
      const now = Date.now();
      const id = overrides.id ?? randomUUID();
      const expiresAt = overrides.expiresAt ?? new Date(now + 7 * DAY);
      const refreshToken = signRefreshToken(userId, id, expiresAt);
      const row = {
        id, userId, refreshToken: sha256(refreshToken), expiresAt, createdAt: new Date(now), userAgent: null, ip: null,
        lastUsedAt: new Date(now), absoluteExpiresAt: new Date(now + 30 * DAY), previousTokenHash: null, rotatedAt: null, revokedAt: null, revokeReason: null,
        ...overrides,
      };
      state.sessions.set(id, row);
      const user = state.users.get(userId);
      return { id, row, refreshToken, accessToken: signAccessToken(userId, user?.username ?? userId, id) };
    },
    /** Revoke a row directly, as another server process would (no listener in this process runs). */
    revokeRow(id, reason = 'LOGOUT') {
      Object.assign(state.sessions.get(id), { revokedAt: new Date(), revokeReason: reason });
      clearAuthCache();
    },
    seat(userId, tableId) { state.seats.set(userId, { userId, tableId }); },
    table(row) { state.tables.set(row.id, row); },
  };

  const gate = async (key) => {
    await Promise.resolve();
    db.calls[key] = (db.calls[key] ?? 0) + 1;
    const hold = holds.get(key);
    if (hold && hold.count > 0) {
      hold.count -= 1;
      await new Promise((resolve) => { hold.waiting.push(resolve); if (hold.count === 0) for (const release of hold.waiting) release(); });
    }
    if (db.down) throw outage();
    const left = failures.get(key) ?? 0;
    if (left > 0) { failures.set(key, left - 1); throw outage(); }
  };
  const unique = (table, row, fields, ignoreId) => {
    for (const field of fields) {
      if (row[field] == null) continue;
      for (const other of table.values()) if (other.id !== ignoreId && other[field] === row[field]) throw uniqueViolation([field]);
    }
  };
  const withUser = (row, include) => row && include?.user ? { ...structuredClone(row), user: structuredClone(state.users.get(row.userId)) } : row;

  const api = {
    user: {
      findUnique: async ({ where, select }) => {
        await gate('user.findUnique');
        const row = [...state.users.values()].find((u) => matches(u, where));
        return row ? pick(row, select) : null;
      },
      create: async ({ data }) => {
        await gate('user.create');
        for (const hook of createHooks) await hook(data);
        const now = new Date();
        const row = {
          id: `user-${randomUUID()}`, email: null, passwordHash: null, isGuest: false, role: 'PLAYER', kind: 'HUMAN', botProfile: null, bankroll: 10_000, avatarHue: 210,
          createdAt: now, updatedAt: now, lastSeenAt: null, failedLoginCount: 0, lockedUntil: null, termsVersion: null, termsAcceptedAt: null, ageConfirmedAt: null,
          ...structuredClone(data), usernameCanonical: data.username.toLowerCase(),
        };
        unique(state.users, row, ['username', 'usernameCanonical', 'email']);
        state.users.set(row.id, row);
        return structuredClone(row);
      },
      update: async ({ where, data, select }) => {
        await gate('user.update');
        const row = state.users.get(where.id);
        if (!row) throw new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: 'test' });
        apply(row, data);
        return pick(row, select);
      },
      updateMany: async ({ where, data }) => {
        await gate('user.updateMany');
        const rows = [...state.users.values()].filter((u) => matches(u, where));
        for (const row of rows) apply(row, data);
        return { count: rows.length };
      },
    },
    session: {
      create: async ({ data }) => {
        await gate('session.create');
        const now = new Date();
        const row = { id: randomUUID(), createdAt: now, lastUsedAt: now, userAgent: null, ip: null, previousTokenHash: null, rotatedAt: null, revokedAt: null, revokeReason: null, ...structuredClone(data) };
        unique(state.sessions, row, ['id', 'refreshToken']);
        state.sessions.set(row.id, row);
        return structuredClone(row);
      },
      findUnique: async ({ where, include, select }) => {
        await gate('session.findUnique');
        const row = state.sessions.get(where.id);
        if (!row) return null;
        return include ? withUser(row, include) : pick(row, select);
      },
      findMany: async ({ where, select, orderBy }) => {
        await gate('session.findMany');
        let rows = [...state.sessions.values()].filter((s) => matches(s, where));
        if (orderBy?.lastUsedAt) rows = rows.sort((a, b) => (b.lastUsedAt - a.lastUsedAt) * (orderBy.lastUsedAt === 'desc' ? 1 : -1));
        return rows.map((row) => pick(row, select));
      },
      updateMany: async ({ where, data }) => {
        await gate('session.updateMany');
        const rows = [...state.sessions.values()].filter((s) => matches(s, where));
        for (const row of rows) Object.assign(row, structuredClone(data));
        return { count: rows.length };
      },
      updateManyAndReturn: async ({ where, data, select }) => {
        await gate('session.updateManyAndReturn');
        const rows = [...state.sessions.values()].filter((s) => matches(s, where));
        for (const row of rows) Object.assign(row, structuredClone(data));
        return rows.map((row) => pick(row, select));
      },
    },
    tableSeat: {
      findUnique: async ({ where }) => { await gate('tableSeat.findUnique'); const seat = state.seats.get(where.userId); return seat ? { tableId: seat.tableId } : null; },
      findFirst: async ({ where }) => { await gate('tableSeat.findFirst'); const seat = state.seats.get(where.userId); return seat && (!where.tableId || seat.tableId === where.tableId) ? { id: 'seat' } : null; },
    },
    table: {
      findUnique: async ({ where, select }) => { await gate('table.findUnique'); const row = state.tables.get(where.id); return row ? pick(row, select) : null; },
    },
    hand: { findFirst: async () => null },
  };

  const replace = (target, name, implementation) => {
    const original = target[name]; target[name] = implementation;
    t.after(() => { target[name] = original; });
  };
  for (const [delegate, methods] of Object.entries(api)) for (const [method, impl] of Object.entries(methods)) replace(prisma[delegate], method, impl);
  // Interactive transactions: all-or-nothing over the in-memory rows.
  replace(prisma, '$transaction', async (run) => {
    const snapshot = structuredClone(state);
    try { return await run(api); } catch (err) { state = snapshot; throw err; }
  });
  clearAuthCache();
  t.after(() => clearAuthCache());
  return db;
}
