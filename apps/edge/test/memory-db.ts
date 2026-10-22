import type { AppDb } from "../src/http/db";
import { passwords } from "../src/auth/password";
import { hashRefresh } from "../src/auth/sessions";
import { signAccessToken, signRefreshToken } from "../src/auth/tokens";

const DAY = 86_400_000;

export function uniqueViolation(target: string[]): Error {
  const err = new Error("Unique constraint failed");
  err.name = "PrismaClientKnownRequestError";
  return Object.assign(err, { code: "P2002", meta: { target } });
}

export function outage(): Error {
  const err = new Error("Can't reach database server at 127.0.0.1:5432");
  err.name = "PrismaClientInitializationError";
  return err;
}

function notFound(): Error {
  const err = new Error("Record not found");
  err.name = "PrismaClientKnownRequestError";
  return Object.assign(err, { code: "P2025" });
}

interface UserRow {
  id: string;
  email: string | null;
  username: string;
  usernameCanonical: string;
  passwordHash: string | null;
  isGuest: boolean;
  role: string;
  kind: string;
  botProfile: string | null;
  bankroll: number;
  avatarHue: number;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
  ageConfirmedAt: Date | null;
  emailVerifiedAt: Date | null;
  credentialsVersion: number;
  passwordChangedAt: Date | null;
  passwordResetRequired: boolean;
  mfaFailedCount: number;
  mfaLockedUntil: Date | null;
  securityHoldUntil: Date | null;
  webauthnUserId: string | null;
}

/** Defaults of the account-security user columns (migration 20261019100000_account_security). */
const USER_SECURITY_DEFAULTS = {
  emailVerifiedAt: null,
  credentialsVersion: 0,
  passwordChangedAt: null,
  passwordResetRequired: false,
  mfaFailedCount: 0,
  mfaLockedUntil: null,
  securityHoldUntil: null,
  webauthnUserId: null,
} as const;

const sessionSecurityDefaults = () => ({
  deviceId: null,
  persistent: true,
  authMethods: [] as string[],
  reauthAt: null,
  reauthMethods: [] as string[],
});

interface SessionRow {
  id: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  createdAt: Date;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: Date;
  absoluteExpiresAt: Date;
  previousTokenHash: string | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  deviceId: string | null;
  persistent: boolean;
  authMethods: string[];
  reauthAt: Date | null;
  reauthMethods: string[];
}

/** A row of one of the account-security tables. */
export type Row = Record<string, any> & { id: string };

/** The account-security tables, by AppDb delegate name. */
export const SECURITY_TABLES = [
  "knownDevice", "userTotp", "userBackupCode", "webAuthnCredential", "emailToken", "authNonce",
  "accountSecurityEvent", "stepUpGrant", "stepUpEmailChallenge",
] as const;
export type SecurityTable = (typeof SECURITY_TABLES)[number];

/** Columns each table fills in when an insert leaves them out (schema.prisma defaults). */
const TABLE_DEFAULTS: Record<SecurityTable, (now: Date) => Record<string, unknown>> = {
  knownDevice: (now) => ({ label: null, userAgent: null, lastIp: null, country: null, firstSeenAt: now, lastSeenAt: now }),
  userTotp: (now) => ({ enabledAt: null, disabledAt: null, lastUsedStep: 0, createdAt: now }),
  userBackupCode: (now) => ({ usedAt: null, createdAt: now }),
  webAuthnCredential: (now) => ({ counter: 0, transports: [], backedUp: false, aaguid: null, createdAt: now, lastUsedAt: null, removedAt: null }),
  emailToken: (now) => ({ data: {}, consumedAt: null, createdAt: now }),
  authNonce: (now) => ({ createdAt: now }),
  accountSecurityEvent: (now) => ({ sessionId: null, ip: null, userAgent: null, country: null, data: {}, createdAt: now }),
  stepUpGrant: () => ({ consumedAt: null }),
  stepUpEmailChallenge: () => ({ attempts: 0, consumedAt: null }),
};

/** Unique keys per table (single columns or composites), as in the migration. */
const TABLE_UNIQUE: Record<SecurityTable, string[][]> = {
  knownDevice: [["id"], ["userId", "deviceHash"]],
  userTotp: [["userId"]],
  userBackupCode: [["id"], ["userId", "codeHash"]],
  webAuthnCredential: [["id"], ["credentialId"]],
  emailToken: [["id"], ["tokenHash"]],
  authNonce: [["id"]],
  accountSecurityEvent: [["id"]],
  stepUpGrant: [["id"]],
  stepUpEmailChallenge: [["id"]],
};

interface SeatRow {
  id: string;
  tableId: string;
  seatIndex: number;
  userId: string | null;
  playerKind: string;
  botProfile: string | null;
  stack: number;
  status: string;
  sittingOut: boolean;
}

interface TableRow {
  id: string;
  name: string;
  hostId: string | null;
  status: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  timeBankMs: number;
  isPrivate: boolean;
  createdAt: Date;
  closedAt: Date | null;
  seats: SeatRow[];
}

interface DbState {
  users: Map<string, UserRow>;
  sessions: Map<string, SessionRow>;
  seats: Map<string, SeatRow>;
  tables: Map<string, TableRow>;
  security: Record<SecurityTable, Map<string, Row>>;
}

function emptySecurity(): Record<SecurityTable, Map<string, Row>> {
  return Object.fromEntries(SECURITY_TABLES.map((name) => [name, new Map<string, Row>()])) as Record<SecurityTable, Map<string, Row>>;
}

const OPERATORS = new Set(["not", "in", "notIn", "gt", "gte", "lt", "lte", "equals"]);

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : typeof value === "bigint" ? Number(value) : value;
}

function equal(value: unknown, target: unknown): boolean {
  if (target instanceof Date) return value instanceof Date && value.getTime() === target.getTime();
  return comparable(value) === comparable(target);
}

/** Prisma filter semantics for the operators the routes use; several operators on one field all apply. */
function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (cond instanceof Date || typeof cond !== "object" || Array.isArray(cond)) return equal(value, cond);
  const ops = cond as Record<string, unknown>;
  if (!Object.keys(ops).every((key) => OPERATORS.has(key))) return JSON.stringify(value) === JSON.stringify(cond);
  return Object.entries(ops).every(([op, target]) => {
    const a = comparable(value) as number;
    const b = comparable(target) as number;
    switch (op) {
      case "not":
        if (target === null) return value != null;
        if (typeof target === "object" && !(target instanceof Date)) return !matchesCondition(value, target);
        return !equal(value, target);
      case "in": return (target as unknown[]).some((entry) => equal(value, entry));
      case "notIn": return !(target as unknown[]).some((entry) => equal(value, entry));
      case "equals": return equal(value, target);
      case "gt": return value != null && a > b;
      case "gte": return value != null && a >= b;
      case "lt": return value != null && a < b;
      case "lte": return value != null && a <= b;
      default: return false;
    }
  });
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((branch) => matches(row, branch));
    if (key === "AND") return (cond as Record<string, unknown>[]).every((branch) => matches(row, branch));
    return matchesCondition(row[key], cond);
  });
}

function pick(row: object, select?: Record<string, boolean>): unknown {
  const clone = structuredClone(row);
  if (!select) return clone;
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, (clone as Record<string, unknown>)[key]]));
}

function sortRows<T extends object>(rows: T[], orderBy: unknown): T[] {
  const orders = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
  if (orders.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      for (const [key, dir] of Object.entries(order)) {
        const x = comparable((a as Record<string, unknown>)[key]) as number;
        const y = comparable((b as Record<string, unknown>)[key]) as number;
        if (x === y) continue;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
    }
    return 0;
  });
}

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    const op = value && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value) ? value as Record<string, number> : null;
    if (op && "increment" in op) row[key] = (row[key] as number) + op.increment!;
    else if (op && "decrement" in op) row[key] = (row[key] as number) - op.decrement!;
    else row[key] = structuredClone(value);
  }
}

function apply(row: Record<string, unknown>, data: Record<string, unknown>): void {
  applyData(row, data);
  row.updatedAt = new Date();
}

export interface MemorySecrets {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  passwordIterations: number;
}

export interface MemoryDb {
  api: AppDb;
  down: boolean;
  calls: Record<string, number>;
  fail(key: string, times?: number): void;
  hold(key: string, count: number): void;
  onUserCreate(hook: (data: Record<string, unknown>) => void | Promise<void>): void;
  readonly users: Map<string, UserRow>;
  user(id: string): UserRow | undefined;
  userByName(username: string): UserRow | undefined;
  session(id: string): SessionRow | undefined;
  sessionsOf(userId: string): SessionRow[];
  addUser(overrides?: Record<string, unknown> & { username?: string; password?: string }): UserRow;
  addSession(userId: string, overrides?: Record<string, unknown>): Promise<{ id: string; refreshToken: string; accessToken: string }>;
  revokeRow(id: string, reason?: string): void;
  /** Rows of an account-security table (live objects: tests may edit them). */
  rows(table: SecurityTable): Row[];
  /** Insert a row directly (defaults and unique keys apply). */
  insert(table: SecurityTable, data: Record<string, unknown>): Row;
}

export function createMemoryDb(secrets: MemorySecrets): MemoryDb {
  let state: DbState = { users: new Map(), sessions: new Map(), seats: new Map(), tables: new Map(), security: emptySecurity() };
  const failures = new Map<string, number>();
  const holds = new Map<string, { count: number; waiting: Array<() => void> }>();
  const createHooks: Array<(data: Record<string, unknown>) => void | Promise<void>> = [];

  const checkSecurityUnique = (table: SecurityTable, next: Row, self: Row | null) => {
    for (const key of TABLE_UNIQUE[table]) {
      if (key.some((field) => next[field] == null)) continue;
      for (const other of state.security[table].values()) {
        if (other !== self && key.every((field) => equal(other[field], next[field]))) throw uniqueViolation(key);
      }
    }
  };

  const insertRow = (table: SecurityTable, data: Record<string, unknown>): Row => {
    const row = { id: crypto.randomUUID(), ...TABLE_DEFAULTS[table](new Date()), ...structuredClone(data) } as Row;
    if (table === "userTotp") row.id = String(row.userId);
    checkSecurityUnique(table, row, null);
    state.security[table].set(row.id, row);
    return row;
  };

  const db: MemoryDb = {
    api: undefined as unknown as AppDb,
    down: false,
    calls: {},
    fail(key, times = 1) { failures.set(key, (failures.get(key) ?? 0) + times); },
    hold(key, count) { holds.set(key, { count, waiting: [] }); },
    onUserCreate(hook) { createHooks.push(hook); },
    get users() { return state.users; },
    user: (id) => state.users.get(id),
    userByName: (username) => [...state.users.values()].find((user) => user.username === username),
    session: (id) => state.sessions.get(id),
    sessionsOf: (userId) => [...state.sessions.values()].filter((session) => session.userId === userId),
    addUser(overrides = {}) {
      const username = overrides.username ?? `Player_${state.users.size + 1}`;
      const { password, ...rest } = overrides;
      const now = new Date();
      const user: UserRow = {
        id: `user-${crypto.randomUUID()}`,
        email: null,
        passwordHash: typeof password === "string" ? passwords.hashSync(password, secrets.passwordIterations) : null,
        isGuest: false,
        role: "PLAYER",
        kind: "HUMAN",
        botProfile: null,
        bankroll: 10_000,
        avatarHue: 0,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        termsVersion: null,
        termsAcceptedAt: null,
        ageConfirmedAt: null,
        ...USER_SECURITY_DEFAULTS,
        ...(rest as Partial<UserRow>),
        username,
        usernameCanonical: username.toLowerCase(),
      };
      state.users.set(user.id, user);
      return user;
    },
    async addSession(userId, overrides = {}) {
      const now = Date.now();
      const id = typeof overrides.id === "string" ? overrides.id : crypto.randomUUID();
      const expiresAt = overrides.expiresAt instanceof Date ? overrides.expiresAt : new Date(now + 7 * DAY);
      const absoluteExpiresAt = overrides.absoluteExpiresAt instanceof Date ? overrides.absoluteExpiresAt : new Date(now + 30 * DAY);
      const refreshToken = await signRefreshToken(secrets.refreshSecret, userId, id, expiresAt);
      const user = state.users.get(userId);
      const row: SessionRow = {
        id,
        userId,
        expiresAt,
        createdAt: overrides.createdAt instanceof Date ? overrides.createdAt : new Date(now),
        userAgent: null,
        ip: null,
        lastUsedAt: new Date(now),
        absoluteExpiresAt,
        previousTokenHash: null,
        rotatedAt: null,
        revokedAt: null,
        revokeReason: null,
        ...sessionSecurityDefaults(),
        ...(overrides as Partial<SessionRow>),
        refreshToken: await hashRefresh(refreshToken),
      };
      state.sessions.set(id, row);
      const accessToken = await signAccessToken(secrets.accessSecret, userId, user?.username ?? userId, id, secrets.accessTtlSeconds);
      return { id, refreshToken, accessToken };
    },
    revokeRow(id, reason = "LOGOUT") {
      const row = state.sessions.get(id);
      if (row) Object.assign(row, { revokedAt: new Date(), revokeReason: reason });
    },
    rows: (table) => [...state.security[table].values()],
    insert: (table, data) => insertRow(table, data),
  };

  const gate = async (key: string) => {
    await Promise.resolve();
    db.calls[key] = (db.calls[key] ?? 0) + 1;
    const hold = holds.get(key);
    if (hold && hold.count > 0) {
      hold.count -= 1;
      await new Promise<void>((resolve) => {
        hold.waiting.push(resolve);
        if (hold.count === 0) for (const release of hold.waiting) release();
      });
    }
    if (db.down) throw outage();
    const left = failures.get(key) ?? 0;
    if (left > 0) {
      failures.set(key, left - 1);
      throw outage();
    }
  };

  const unique = (table: Map<string, { id: string } & Record<string, unknown>>, row: { id: string } & Record<string, unknown>, fields: string[]) => {
    for (const field of fields) {
      if (row[field] == null) continue;
      for (const other of table.values()) {
        if (other.id !== row.id && other[field] === row[field]) throw uniqueViolation([field]);
      }
    }
  };
  const users = () => state.users as unknown as Map<string, { id: string } & Record<string, unknown>>;
  /** Apply an update to a copy first, so a unique violation leaves the row unchanged (as Postgres does). */
  const updateUser = (row: UserRow, data: Record<string, unknown>) => {
    const next = structuredClone(row);
    apply(next as unknown as Record<string, unknown>, data);
    unique(users(), next as unknown as { id: string } & Record<string, unknown>, ["email", "webauthnUserId"]);
    apply(row as unknown as Record<string, unknown>, data);
  };

  /** Prisma-like delegates over the account-security tables. */
  const securityDelegate = (table: SecurityTable) => {
    const found = (where: Record<string, unknown> | undefined) => [...state.security[table].values()].filter((row) => matches(row, where ?? {}));
    const key = (method: string) => `${table}.${method}`;
    return {
      findUnique: async ({ where, select }: any) => {
        await gate(key("findUnique"));
        const row = found(where)[0];
        return row ? pick(row, select) : null;
      },
      findFirst: async ({ where, select, orderBy }: any = {}) => {
        await gate(key("findFirst"));
        const row = sortRows(found(where), orderBy)[0];
        return row ? pick(row, select) : null;
      },
      findMany: async ({ where, select, orderBy, take }: any = {}) => {
        await gate(key("findMany"));
        let rows = sortRows(found(where), orderBy);
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((row) => pick(row, select));
      },
      count: async ({ where }: any = {}) => {
        await gate(key("count"));
        return found(where).length;
      },
      create: async ({ data, select }: any) => {
        await gate(key("create"));
        return pick(insertRow(table, data), select);
      },
      createMany: async ({ data }: any) => {
        await gate(key("createMany"));
        const list = Array.isArray(data) ? data : [data];
        for (const entry of list) insertRow(table, entry);
        return { count: list.length };
      },
      update: async ({ where, data, select }: any) => {
        await gate(key("update"));
        const row = found(where)[0];
        if (!row) throw notFound();
        const next = structuredClone(row);
        applyData(next, data);
        checkSecurityUnique(table, next, row);
        applyData(row, data);
        return pick(row, select);
      },
      updateMany: async ({ where, data }: any) => {
        await gate(key("updateMany"));
        const rows = found(where);
        for (const row of rows) applyData(row, data);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: any = {}) => {
        await gate(key("deleteMany"));
        const rows = found(where);
        for (const row of rows) state.security[table].delete(row.id);
        if (table === "knownDevice") {
          // Session.deviceId is ON DELETE SET NULL.
          const gone = new Set(rows.map((row) => row.id));
          for (const session of state.sessions.values()) if (session.deviceId && gone.has(session.deviceId)) session.deviceId = null;
        }
        return { count: rows.length };
      },
    };
  };

  const api: AppDb = {
    user: {
      findUnique: async ({ where, select }) => {
        await gate("user.findUnique");
        const row = [...state.users.values()].find((user) => matches(user as unknown as Record<string, unknown>, where));
        return row ? pick(row, select) : null;
      },
      create: async ({ data }) => {
        await gate("user.create");
        for (const hook of createHooks) await hook(data);
        const now = new Date();
        const row: UserRow = {
          id: `user-${crypto.randomUUID()}`,
          email: null,
          passwordHash: null,
          isGuest: false,
          role: "PLAYER",
          kind: "HUMAN",
          botProfile: null,
          bankroll: 10_000,
          avatarHue: 210,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
          termsVersion: null,
          termsAcceptedAt: null,
          ageConfirmedAt: null,
          ...USER_SECURITY_DEFAULTS,
          ...structuredClone(data),
          usernameCanonical: String(data.username).toLowerCase(),
        };
        unique(users(), row as unknown as { id: string } & Record<string, unknown>, ["username", "usernameCanonical", "email", "webauthnUserId"]);
        state.users.set(row.id, row);
        return structuredClone(row);
      },
      update: async ({ where, data, select }) => {
        await gate("user.update");
        const row = state.users.get(where.id);
        if (!row) throw notFound();
        updateUser(row, data);
        return pick(row, select);
      },
      updateMany: async ({ where, data }) => {
        await gate("user.updateMany");
        const rows = [...state.users.values()].filter((user) => matches(user as unknown as Record<string, unknown>, where));
        for (const row of rows) updateUser(row, data);
        return { count: rows.length };
      },
    },
    session: {
      create: async ({ data }) => {
        await gate("session.create");
        const now = new Date();
        const row = {
          id: crypto.randomUUID(),
          createdAt: now,
          lastUsedAt: now,
          userAgent: null,
          ip: null,
          previousTokenHash: null,
          rotatedAt: null,
          revokedAt: null,
          revokeReason: null,
          ...sessionSecurityDefaults(),
          ...structuredClone(data),
        } as SessionRow;
        unique(state.sessions as unknown as Map<string, { id: string } & Record<string, unknown>>, row as unknown as { id: string } & Record<string, unknown>, ["id", "refreshToken"]);
        state.sessions.set(row.id, row);
        return structuredClone(row);
      },
      findUnique: async ({ where, include, select }) => {
        await gate("session.findUnique");
        const row = state.sessions.get(where.id);
        if (!row) return null;
        if (include?.user) {
          const user = state.users.get(row.userId);
          return { ...structuredClone(row), user: user ? structuredClone(user) : null };
        }
        return pick(row, select);
      },
      findMany: async ({ where, select, orderBy }) => {
        await gate("session.findMany");
        const rows = sortRows([...state.sessions.values()].filter((session) => matches(session as unknown as Record<string, unknown>, where ?? {})), orderBy);
        return rows.map((row) => pick(row, select));
      },
      updateMany: async ({ where, data }) => {
        await gate("session.updateMany");
        const rows = [...state.sessions.values()].filter((session) => matches(session as unknown as Record<string, unknown>, where));
        for (const row of rows) applyData(row as unknown as Record<string, unknown>, data);
        return { count: rows.length };
      },
      updateManyAndReturn: async ({ where, data, select }) => {
        await gate("session.updateManyAndReturn");
        const rows = [...state.sessions.values()].filter((session) => matches(session as unknown as Record<string, unknown>, where));
        for (const row of rows) applyData(row as unknown as Record<string, unknown>, data);
        return rows.map((row) => pick(row, select));
      },
    },
    tableSeat: {
      findUnique: async ({ where }) => {
        await gate("tableSeat.findUnique");
        const seat = where.userId ? state.seats.get(where.userId) : undefined;
        return seat ? { tableId: seat.tableId } : null;
      },
      findFirst: async ({ where }) => {
        await gate("tableSeat.findFirst");
        const seat = where?.userId ? state.seats.get(where.userId) : undefined;
        if (!seat) return null;
        if (where.tableId && seat.tableId !== where.tableId) return null;
        return { id: seat.id, tableId: seat.tableId, userId: seat.userId };
      },
    },
    table: {
      findMany: async ({ where, include, orderBy, take }) => {
        await gate("table.findMany");
        let rows = [...state.tables.values()].filter((table) => {
          if (where?.status?.not && table.status === where.status.not) return false;
          if (where?.isPrivate !== undefined && table.isPrivate !== where.isPrivate) return false;
          if (where?.seats?.none?.playerKind && table.seats.some((seat) => seat.playerKind === where.seats.none.playerKind)) return false;
          return true;
        });
        if (orderBy?.createdAt === "desc") rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((row) => include?.seats ? structuredClone(row) : pick(row));
      },
      findUnique: async ({ where, include, select }) => {
        await gate("table.findUnique");
        const row = state.tables.get(where.id);
        if (!row) return null;
        if (!include) return pick(row, select);
        const clone = structuredClone(row);
        if (include.seats) {
          clone.seats = [...row.seats].sort((a, b) => a.seatIndex - b.seatIndex).map((seat) => {
            const copy = structuredClone(seat) as SeatRow & { user?: UserRow | null };
            if (include.seats.include?.user) copy.user = seat.userId ? structuredClone(state.users.get(seat.userId) ?? null) : null;
            return copy;
          });
        }
        return clone;
      },
      create: async ({ data, select }) => {
        await gate("table.create");
        const id = crypto.randomUUID();
        const seatCreates = Array.isArray(data.seats?.create) ? data.seats.create : [];
        const seats: SeatRow[] = seatCreates.map((seat: SeatRow) => ({
          id: crypto.randomUUID(),
          tableId: id,
          seatIndex: seat.seatIndex,
          userId: seat.userId ?? null,
          playerKind: seat.playerKind ?? "HUMAN",
          botProfile: seat.botProfile ?? null,
          stack: seat.stack ?? 0,
          status: seat.status ?? "EMPTY",
          sittingOut: seat.sittingOut ?? false,
        }));
        for (const seat of seats) {
          if (seat.userId == null) continue;
          if (state.seats.has(seat.userId)) throw uniqueViolation(["userId"]);
          state.seats.set(seat.userId, seat);
        }
        const row: TableRow = {
          id,
          name: data.name,
          hostId: data.hostId ?? null,
          status: data.status ?? "OPEN",
          maxSeats: data.maxSeats,
          smallBlind: data.smallBlind,
          bigBlind: data.bigBlind,
          minBuyIn: data.minBuyIn,
          maxBuyIn: data.maxBuyIn,
          timeBankMs: data.timeBankMs,
          isPrivate: data.isPrivate ?? false,
          createdAt: new Date(),
          closedAt: null,
          seats,
        };
        state.tables.set(id, row);
        return select ? pick(row, select) : structuredClone(row);
      },
    },
    hand: {
      findUnique: async () => {
        await gate("hand.findUnique");
        return null;
      },
      findFirst: async () => {
        await gate("hand.findFirst");
        return null;
      },
    },
    ...(Object.fromEntries(SECURITY_TABLES.map((table) => [table, securityDelegate(table)])) as unknown as Pick<AppDb, SecurityTable>),
    $transaction: async (run) => {
      const snapshot = structuredClone(state);
      try {
        return await run(api);
      } catch (err) {
        state = snapshot;
        throw err;
      }
    },
  };
  db.api = api;
  return db;
}
