/**
 * Start-up database connection with a plain-language diagnosis.
 *
 * The safe-log serializer drops the message of every Prisma error (it can
 * carry query input), so a failed `prisma.$connect()` used to be logged as a
 * bare "PrismaClientInitializationError" with no reason. Here the failure is
 * classified from Prisma's error code and turned into a sentence that names
 * only the database host:port (never the user or password) and what to check.
 *
 * In development a reachability failure is retried with back-off instead of
 * exiting: `tsx watch` does not restart a crashed server until a file
 * changes, so a database that is briefly unreachable (`npm run dev` started
 * before the network was up) would otherwise leave the API down for good.
 * In production the first failure is fatal, as before; the supervisor restarts
 * the process.
 */

export interface DatabaseFailure {
  /** Prisma's error code (P1001, ...) or null. */
  code: string | null;
  /** host:port from the connection URL, or null. Never the credentials. */
  host: string | null;
  /** True when the same settings may work later (network, server starting). */
  retryable: boolean;
  /** What went wrong and what to check, for the operator. */
  hint: string;
}

/** host:port of a connection URL (never user or password), or null. */
export function databaseHost(url: string | undefined): string | null {
  try {
    const host = new URL(url ?? "").host;
    return host || null;
  } catch {
    return null;
  }
}

/** Supabase's direct connection host (db.<project ref>.supabase.co), which has only an IPv6 address. */
const SUPABASE_DIRECT = /^db\.[a-z0-9]+\.supabase\.co(:\d+)?$/i;
/** Codes and socket errors a retry can outlast; credentials, TLS and URL errors cannot. */
const RETRYABLE = new Set(["P1001", "P1002", "P1008", "P1017", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function errorCode(err: unknown): string | null {
  const record = (typeof err === "object" && err !== null ? err : {}) as { errorCode?: unknown; code?: unknown };
  if (typeof record.errorCode === "string" && record.errorCode) return record.errorCode;
  if (typeof record.code === "string" && record.code) return record.code;
  return null;
}

/** Classify a failed connection. Reads Prisma's message only to recognise it; never copies it. */
export function describeDatabaseFailure(err: unknown, url: string | undefined): DatabaseFailure {
  const host = databaseHost(url);
  const at = host ? `the database at ${host}` : "the database";
  const message = typeof (err as { message?: unknown })?.message === "string" ? (err as { message: string }).message : "";
  let code = errorCode(err);
  // Prisma names some failures only in the message.
  if (!code && /can't reach database server/i.test(message)) code = "P1001";
  if (!code && /authentication failed/i.test(message)) code = "P1000";
  const retryable = code !== null && RETRYABLE.has(code);
  let hint: string;
  switch (code) {
    case "P1000":
      hint = `${at} rejected the login in DATABASE_URL (wrong user or password).`;
      break;
    case "P1003":
      hint = `The database named in DATABASE_URL does not exist on ${host ?? "that server"}.`;
      break;
    case "P1010":
      hint = `The user in DATABASE_URL is not allowed to connect to ${at}.`;
      break;
    case "P1011":
      hint = `The TLS connection to ${at} failed: check sslmode and the sslcert path in DATABASE_URL.`;
      break;
    case "P1013":
      hint = "DATABASE_URL is not a valid connection string.";
      break;
    default:
      hint = retryable
        ? `Cannot reach ${at}. Check the internet connection, any VPN or firewall, and DATABASE_URL in .env.`
        : `Could not connect to ${at}${code ? ` (${code})` : ""}. Check DATABASE_URL in .env.`;
  }
  if (retryable && host && SUPABASE_DIRECT.test(host)) {
    hint += " This is Supabase's direct host, which has only an IPv6 address: on a network without working IPv6,"
      + " use the Session pooler connection string instead (Supabase dashboard, Connect, Session pooler), which works over IPv4.";
  }
  return { code, host, retryable, hint };
}

/** Thrown when the database cannot be used at start-up. Its message is the hint (safe to log). */
export class DatabaseConnectError extends Error {
  readonly code: string | null;
  constructor(failure: DatabaseFailure, options: { cause: unknown }) {
    super(failure.hint, options);
    this.name = "DatabaseConnectError";
    this.code = failure.code;
  }
}

export interface ConnectOptions {
  /** DATABASE_URL, used only for its host:port in messages. */
  url: string | undefined;
  /** Retry reachability failures with back-off (development) instead of failing at once. */
  retry: boolean;
  /** Called before each retry wait. */
  onRetry?: (failure: DatabaseFailure, attempt: number, delayMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Longest wait between attempts. */
  maxDelayMs?: number;
}

/** Connect, retrying reachability failures when `retry` is set. Throws DatabaseConnectError otherwise. */
export async function connectDatabase(client: { $connect(): Promise<void> }, options: ConnectOptions): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.$connect();
      return;
    } catch (err) {
      const failure = describeDatabaseFailure(err, options.url);
      if (!options.retry || !failure.retryable) throw new DatabaseConnectError(failure, { cause: err });
      const delayMs = Math.min(maxDelayMs, 1_000 * 2 ** Math.min(attempt - 1, 10));
      options.onRetry?.(failure, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
