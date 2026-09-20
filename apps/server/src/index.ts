import "dotenv/config";
import { createServer, type Server as HttpServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { connectRedis, disconnectRedis } from "./redis/client.js";
import { createSocketServer } from "./socket/index.js";

async function listen(httpServer: HttpServer, port: number, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port);
      });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || i === attempts - 1) throw err;
      logger.warn({ port, attempt: i + 1 }, "port busy, retrying listen");
      await new Promise((r) => setTimeout(r, 350));
    }
  }
}

async function main() {
  await connectRedis();
  await prisma.$connect();

  const app = createApp();
  const httpServer = createServer(app);
  createSocketServer(httpServer);

  await listen(httpServer, env.PORT);
  logger.info(`Poker server listening on :${env.PORT}`);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.$disconnect();
    await disconnectRedis();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(err, "fatal startup error");
  process.exit(1);
});
