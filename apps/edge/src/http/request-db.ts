import { createPrisma } from "../db/client";
import type { Env } from "../env";
import type { AppDb } from "./db";

/**
 * Database clients outside the request's own one. The request's client
 * (app.ts) is disconnected once the response is sent, so work deferred past
 * the response (defer.ts) opens its own. Tests inject an in-memory database
 * on the env object instead, and every client is that database.
 */

const TEST_DATABASE = Symbol.for("poker.edge.httpTestDatabase");

export function attachTestDatabase(env: object, db: AppDb): void {
  Object.defineProperty(env, TEST_DATABASE, { value: db, enumerable: false, configurable: true });
}

export function testDatabase(env: Env): AppDb | null {
  const value = (env as Env & Record<symbol, AppDb | undefined>)[TEST_DATABASE];
  return value ?? null;
}

/** Run `work` with a client of its own (a new Hyperdrive connection), disconnected afterwards. */
export async function withOwnDb<T>(env: Env, work: (db: AppDb) => Promise<T>): Promise<T> {
  const injected = testDatabase(env);
  if (injected) return work(injected);
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) throw new Error("HYPERDRIVE binding is missing");
  const client = createPrisma(connectionString);
  try {
    return await work(client as unknown as AppDb);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}
