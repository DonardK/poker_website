import type { PrismaClient } from "../generated/prisma/client";
import type { Env } from "../env";

/** A new client per event. Dynamic import keeps `pg` out of the health handler graph. */
export async function withPrisma<T>(env: Env, run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const { createPrisma } = await import("../db/client");
  const prisma = createPrisma(env.HYPERDRIVE.connectionString);
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
