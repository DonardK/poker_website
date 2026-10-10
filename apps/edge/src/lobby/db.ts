import { createPrisma } from "../db/client";
import type { PrismaClient } from "../generated/prisma/client";
import type { Env } from "../env";

/** A new client per event. The generated client is already loaded at startup. */
export async function withPrisma<T>(env: Env, run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = createPrisma(env.HYPERDRIVE.connectionString);
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
