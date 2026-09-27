import { tableManager } from "./game/manager.js";
import { createApp } from "./app.js";
import { env } from "./config.js";
import { assertGameSchemaReady, prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { connectRedis, disconnectRedis } from "./redis/client.js";
import { createSocketServer } from "./socket/index.js";
import { createListener, type WebServer } from "./transport.js";

async function listen(httpServer: WebServer, port: number, attempts = 10): Promise<void> {
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
  await assertGameSchemaReady();

  const app = createApp();
  // COMPLIANCE (TLS): node:https when certificate files are configured. In
  // production without them, config.ts requires a trusted TLS proxy, and
  // app.ts (HTTP API) and the engine.io transport guard (every Socket.io
  // request, see socket/index.ts) refuse requests that did not use TLS.
  const { server: httpServer, secure } = createListener(app, { certFile: env.TLS_CERT_FILE, keyFile: env.TLS_KEY_FILE });
  const io = createSocketServer(httpServer);
  await tableManager.recover();

  await listen(httpServer, env.PORT);
  logger.info({ tls: secure ? "direct" : env.TRUST_PROXY_HOPS > 0 ? "proxy" : "none" }, `Poker server listening on ${secure ? "https" : "http"}://:${env.PORT}`);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    tableManager.stop();
    io.close();
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
