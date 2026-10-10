import bcrypt from "bcryptjs";
import type { AppDb } from "../src/http/db";
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
}

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
}

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
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond === null) return value == null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === "object" && cond !== null) {
      const op = cond as { not?: unknown; in?: unknown[]; gt?: unknown; gte?: unknown; lt?: unknown };
      if ("not" in op) return value !== op.not;
      if ("in" in op) return (op.in ?? []).includes(value);
      if ("gt" in op) return value != null && (value as number) > (op.gt as number);
      if ("gte" in op) return value != null && (value as number) >= (op.gte as number);
      if ("lt" in op) return value != null && (value as number) < (op.lt as number);
    }
    return value === cond;
  });
}

function pick(row: object, select?: Record<string, boolean>): unknown {
  const clone = structuredClone(row);
  if (!select) return clone;
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, (clone as Record<string, unknown>)[key]]));
}

function apply(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !(value instanceof Date) && "increment" in (value as object)) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else if (value && typeof value === "object" && !(value instanceof Date) && "decrement" in (value as object)) {
      row[key] = (row[key] as number) - (value as { decrement: number }).decrement;
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

export interface MemorySecrets {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
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
}

export function createMemoryDb(secrets: MemorySecrets): MemoryDb {
  let state: DbState = { users: new Map(), sessions: new Map(), seats: new Map(), tables: new Map() };
  const failures = new Map<string, number>();
  const holds = new Map<string, { count: number; waiting: Array<() => void> }>();
  const createHooks: Array<(data: Record<string, unknown>) => void | Promise<void>> = [];
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
        passwordHash: typeof password === "string" ? bcrypt.hashSync(password, 4) : null,
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
          ...structuredClone(data),
          usernameCanonical: String(data.username).toLowerCase(),
        };
        unique(state.users as unknown as Map<string, { id: string } & Record<string, unknown>>, row as unknown as { id: string } & Record<string, unknown>, ["username", "usernameCanonical", "email"]);
        state.users.set(row.id, row);
        return structuredClone(row);
      },
      update: async ({ where, data, select }) => {
        await gate("user.update");
        const row = state.users.get(where.id);
        if (!row) {
          const err = new Error("Record not found");
          err.name = "PrismaClientKnownRequestError";
          throw Object.assign(err, { code: "P2025" });
        }
        apply(row as unknown as Record<string, unknown>, data);
        return pick(row, select);
      },
      updateMany: async ({ where, data }) => {
        await gate("user.updateMany");
        const rows = [...state.users.values()].filter((user) => matches(user as unknown as Record<string, unknown>, where));
        for (const row of rows) apply(row as unknown as Record<string, unknown>, data);
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
        let rows = [...state.sessions.values()].filter((session) => matches(session as unknown as Record<string, unknown>, where ?? {}));
        if (orderBy?.lastUsedAt) {
          const dir = orderBy.lastUsedAt === "desc" ? -1 : 1;
          rows = rows.sort((a, b) => (a.lastUsedAt.getTime() - b.lastUsedAt.getTime()) * dir);
        }
        return rows.map((row) => pick(row, select));
      },
      updateMany: async ({ where, data }) => {
        await gate("session.updateMany");
        const rows = [...state.sessions.values()].filter((session) => matches(session as unknown as Record<string, unknown>, where));
        for (const row of rows) Object.assign(row, structuredClone(data));
        return { count: rows.length };
      },
      updateManyAndReturn: async ({ where, data, select }) => {
        await gate("session.updateManyAndReturn");
        const rows = [...state.sessions.values()].filter((session) => matches(session as unknown as Record<string, unknown>, where));
        for (const row of rows) Object.assign(row, structuredClone(data));
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
