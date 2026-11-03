/**
 * Payments flows against the real embedded PostgreSQL, through the Workers'
 * Prisma client, with the two logins production uses: poker_payments_app
 * (HYPERDRIVE_PAYMENTS, the payments Worker) and poker_app (HYPERDRIVE, the
 * runtime, which also writes the fixtures only it may write: users,
 * sessions, step-up grants). The providers are the built-in sandbox with an
 * in-memory store, so a test can press the sandbox page's buttons and
 * deliver signed webhooks itself; the clock can be moved.
 *
 * Runs under `node apps/server/test/support/pg.mjs --exec "npm test -w @poker/edge"`.
 * Without that database the suites skip, unless POKER_REQUIRE_DB_TESTS=1 (CI), where they fail.
 */
import { env } from "cloudflare:workers";
import type { PrismaClient } from "../../../src/generated/prisma/client";
import { createPrisma } from "../../../src/db/client";
import { readPaymentsConfig, type PaymentsActiveConfig, type PaymentsVars } from "../../../src/payments/config";
import type { Caller } from "../../../src/payments/contract";
import type { PaymentsContext } from "../../../src/payments/context";
import type { PaymentsEnv } from "../../../src/payments/env";
import { ingestWebhook } from "../../../src/payments/inbox";
import { buildProviders } from "../../../src/payments/providers/registry";
import { memorySandboxStore, signSandboxBody, SANDBOX_SIGNATURE_HEADER, type SandboxEnvelope } from "../../../src/payments/providers/sandbox";

const bindings = env as unknown as { HYPERDRIVE?: Hyperdrive; HYPERDRIVE_TEST_RUNTIME?: Hyperdrive; HYPERDRIVE_PAYMENTS?: Hyperdrive; HYPERDRIVE_TEST_ADMIN?: Hyperdrive; POKER_REQUIRE_DB_TESTS?: string };

export const SANDBOX_SECRET = "test-only-sandbox-webhook-secret-32ch";
export const SITE = "https://poker-web-preview.example.workers.dev";
export const PAYMENTS_ORIGIN = "https://poker-payments-preview.example.workers.dev";

export const SANDBOX_VARS: PaymentsVars = {
  ENVIRONMENT: "development",
  PAYMENTS_MODE: "sandbox",
  PUBLIC_SITE_ORIGIN: SITE,
  PAYMENTS_PUBLIC_ORIGIN: PAYMENTS_ORIGIN,
  SANDBOX_WEBHOOK_SECRET: SANDBOX_SECRET,
  CARD_PROVIDER_KEY: "sandbox",
  CRYPTO_PROVIDER_KEY: "sandbox",
  KYC_PROVIDER_KEY: "sandbox",
  CRYPTO_PAY_ASSETS: "USDC_ERC20,BTC,ETH",
  NOTIFY_LINK_SECRET: "test-only-notify-link-secret-0123456789abcdef",
};

export const requireDb = bindings.POKER_REQUIRE_DB_TESTS === "1";

function local(hyperdrive: Hyperdrive | undefined): string | null {
  if (!hyperdrive) return null;
  try {
    const host = new URL(hyperdrive.connectionString).hostname;
    return host === "127.0.0.1" || host === "localhost" || host.endsWith(".hyperdrive.local") ? hyperdrive.connectionString : null;
  } catch {
    return null;
  }
}

async function connect(connectionString: string | null): Promise<PrismaClient | null> {
  if (!connectionString) return null;
  try {
    const client = createPrisma(connectionString);
    await client.$queryRaw`SELECT 1`;
    return client;
  } catch {
    return null;
  }
}

export interface Fixture {
  payments: PrismaClient;
  runtime: PrismaClient;
  config: PaymentsActiveConfig;
  store: ReturnType<typeof memorySandboxStore>;
  clock: { offsetMs: number };
  now(): Date;
  kicks: number;
  ctx(): PaymentsContext;
  /** Runs everything a context deferred (webhook processing). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Both logins, or null when the test database is absent (the suite then skips, or fails in CI). */
export async function openFixture(vars: PaymentsVars = {}): Promise<Fixture | null> {
  const runtime = await connect(local(bindings.HYPERDRIVE_TEST_RUNTIME ?? bindings.HYPERDRIVE));
  const payments = await connect(local(bindings.HYPERDRIVE_PAYMENTS));
  if (!runtime || !payments) {
    await runtime?.$disconnect();
    await payments?.$disconnect();
    if (requireDb) throw new Error("POKER_REQUIRE_DB_TESTS=1 but the payments test database is unreachable");
    return null;
  }
  const config = readPaymentsConfig({ ...SANDBOX_VARS, ...vars });
  if (config.mode === "off") throw new Error("fixture needs an active mode");
  const store = memorySandboxStore();
  const clock = { offsetMs: 0 };
  const deferred: Promise<unknown>[] = [];
  const now = () => new Date(Date.now() + clock.offsetMs);
  const fixture: Fixture = {
    payments, runtime, config, store, clock, now, kicks: 0,
    ctx() {
      return {
        db: payments, config, now,
        providers: buildProviders({} as PaymentsEnv, config, { now, sandboxStore: store }),
        kick: async () => { fixture.kicks += 1; },
        defer: (work) => { deferred.push(work.catch(() => undefined)); },
      };
    },
    async flush() {
      while (deferred.length > 0) await Promise.allSettled(deferred.splice(0, deferred.length));
    },
    async close() {
      await fixture.flush();
      await payments.$disconnect();
      await runtime.$disconnect();
    },
  };
  // All flows on (the suites never turn a switch off: other files share the database).
  await payments.paymentSwitch.updateMany({ data: { enabled: true, updatedBy: "test", reason: "payments db tests" } });
  return fixture;
}

export interface Player {
  userId: string;
  sessionId: string;
  caller: Caller;
}

let seq = 0;

/** A signed-up player with a live session; `verified` adds a passed KYC, CLEAR screening and the limits choice. */
/** Makes a player an administrator (only the database superuser may change User.role). */
export async function makeAdmin(f: Fixture, player: Player): Promise<void> {
  const admin = await connect(local(bindings.HYPERDRIVE_TEST_ADMIN));
  if (!admin) throw new Error("HYPERDRIVE_TEST_ADMIN (POKER_TEST_ADMIN_DATABASE_URL) is needed to create an administrator");
  try {
    await admin.$executeRaw`UPDATE public."User" SET "role" = 'ADMIN' WHERE "id" = ${player.userId}`;
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Ages an instrument by `ms` (createdAt and usableAfter): the instrument guard
 * refuses both moves, so this is the superuser with triggers off, test only.
 */
export async function ageInstrument(f: Fixture, id: string, ms: number): Promise<void> {
  const admin = await connect(local(bindings.HYPERDRIVE_TEST_ADMIN));
  if (!admin) throw new Error("HYPERDRIVE_TEST_ADMIN (POKER_TEST_ADMIN_DATABASE_URL) is needed to age an instrument");
  try {
    await admin.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      const at = new Date(Date.now() - ms).toISOString();
      await tx.$executeRaw`UPDATE public."PaymentInstrument" SET "createdAt" = ${at}::timestamp, "usableAfter" = ${at}::timestamp WHERE "id" = ${id}::uuid`;
    });
  } finally {
    await admin.$disconnect();
  }
}

export async function newPlayer(f: Fixture, opts: { verified?: boolean; limitsChosen?: boolean; country?: string; email?: boolean } = {}): Promise<Player> {
  seq += 1;
  const tag = `${crypto.randomUUID().slice(0, 8)}${seq}`;
  const user = await f.runtime.user.create({
    data: { username: `pay_${tag}`, ...(opts.email === false ? {} : { email: `pay_${tag}@example.com`, emailVerifiedAt: new Date() }) },
    select: { id: true },
  }) as { id: string };
  const session = await f.runtime.session.create({
    data: { userId: user.id, refreshToken: `rt_${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000) },
    select: { id: true },
  }) as { id: string };
  const verified = opts.verified ?? true;
  if (verified || opts.limitsChosen) {
    await f.payments.playerCompliance.create({
      data: {
        userId: user.id,
        ...(verified ? {
          kycStatus: "VERIFIED", kycProvider: "sandbox-kyc", kycVerifiedAt: new Date(), legalFirstName: "Test", legalLastName: "Player",
          birthDate: new Date("1990-01-01T00:00:00Z"), residenceCountry: opts.country ?? "MT", screeningStatus: "CLEAR", riskLevel: "LOW",
        } : {}),
        ...(opts.limitsChosen ?? verified ? { rgLimitsPromptedAt: new Date() } : {}),
      },
    });
  }
  return {
    userId: user.id, sessionId: session.id,
    caller: { userId: user.id, sessionId: session.id, requestId: crypto.randomUUID(), ip: "203.0.113.7", ipCountry: opts.country ?? "MT", userAgent: "vitest" },
  };
}

/** A step-up grant the auth API would mint for this session (the runtime login writes StepUpGrant). */
export async function mintGrant(f: Fixture, player: Player, input: { purpose: string; bind: string; method?: string; ttlMs?: number; sessionId?: string }): Promise<string> {
  const createdAt = new Date();
  const row = await f.runtime.stepUpGrant.create({
    data: {
      userId: player.userId, sessionId: input.sessionId ?? player.sessionId, purpose: input.purpose, bindHash: input.bind, method: input.method ?? "TOTP",
      createdAt, expiresAt: new Date(createdAt.getTime() + (input.ttlMs ?? 240_000)),
    },
    select: { id: true },
  }) as { id: string };
  return row.id;
}

/** A webhook signed like the sandbox provider's, through the real ingest path. */
export async function deliver(f: Fixture, ctx: PaymentsContext, providerKey: string, envelope: SandboxEnvelope, opts: { secret?: string; at?: Date } = {}): Promise<Response> {
  const body = JSON.stringify(envelope);
  const request = new Request(`${PAYMENTS_ORIGIN}/webhooks/${providerKey}`, {
    method: "POST", body,
    headers: { "content-type": "application/json", [SANDBOX_SIGNATURE_HEADER]: await signSandboxBody(opts.secret ?? SANDBOX_SECRET, body, opts.at ?? f.now()) },
  });
  return ingestWebhook(ctx, { sourceIp: "198.51.100.10" }, providerKey, request);
}

/** USER_AVAILABLE and USER_WITHDRAWAL_HOLD of a user, minor units. */
export async function balances(f: Fixture, userId: string, asset = "TEST_EUR"): Promise<{ available: bigint; held: bigint }> {
  const rows = await f.payments.$queryRaw<{ type: string; balance: string }[]>`
    SELECT "type"::text AS type, "balance"::text AS balance FROM public."LedgerAccount" WHERE "userId" = ${userId} AND "assetCode" = ${asset}`;
  const of = (type: string) => BigInt(rows.find((row) => row.type === type)?.balance ?? "0");
  return { available: of("USER_AVAILABLE"), held: of("USER_WITHDRAWAL_HOLD") };
}

/** Σ balance per asset is zero (the double-entry invariant). */
export async function assetSums(f: Fixture): Promise<Record<string, string>> {
  const rows = await f.payments.$queryRaw<{ asset: string; total: string }[]>`
    SELECT "assetCode" AS asset, SUM("balance")::text AS total FROM public."LedgerAccount" GROUP BY "assetCode"`;
  return Object.fromEntries(rows.map((row) => [row.asset, row.total]));
}
