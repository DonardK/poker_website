import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

/**
 * Value import so the Worker isolate evaluates the generated client and its
 * WASM query compiler at startup. Callers still construct a client per
 * request or Durable Object event. Do not cache the client or a pg pool on
 * globalThis.
 */
export const prismaRuntime = PrismaClient;

/** A new client per request or Durable Object event. Do not store it on globalThis. */
export function createPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
