import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BOT_USERNAMES, DEFAULT_STARTING_BANKROLL } from "@poker/shared";
import { PrismaClient, type BotProfile } from "@prisma/client";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });
loadEnv({ path: resolve(here, "../.env") });

const prisma = new PrismaClient();

const PROFILES: BotProfile[] = ["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"];

async function main() {
  for (const profile of PROFILES) {
    for (const username of BOT_USERNAMES[profile]) {
      const user = await prisma.user.upsert({
        where: { username },
        update: {},
        create: {
          username,
          kind: "BOT",
          botProfile: profile,
          isGuest: true,
          bankroll: DEFAULT_STARTING_BANKROLL,
          avatarHue: Math.abs(hashHue(username)) % 360,
          botStats: { create: { profile } },
        },
      });
      await prisma.botStatistic.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, profile },
      });
    }
  }
  console.log("Seeded canonical bot roster");
}

function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) | 0;
  return h;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
