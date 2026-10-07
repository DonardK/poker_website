import { tableManager } from "./game/manager.js";
import { createApp } from "./app.js";
import { env, proxyTrust } from "./config.js";
import { assertGameSchemaReady, prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { connectRedis, disconnectRedis } from "./redis/client.js";
import { readiness } from "./routes/health.js";
import { serializeError } from "./security/safe-log.js";
import { createSocketServer } from "./socket/index.js";
import { createListener, type WebServer } from "./transport.js";

/** Upper bound for in-flight HTTP requests to finish during a graceful drain. */
const DRAIN_TIMEOUT_MS = 15_000;

// SECURITY: an unexpected error leaves the process in an unknown state (a
// half-applied chip movement, a timer that never fires). Log it through the
// allow-list serializer (no request bodies, no stack in production) and exit
// non-zero so the supervisor replaces the process; recovery reloads every
// table from Postgres.
const fatal = (kind: string) => (err: unknown) => {
  logger.fatal({ err: serializeError(err, env.NODE_ENV !== "production"), kind }, "fatal process error");
  process.exit(1);
};
process.on("uncaughtException", fatal("uncaughtException"));
process.on("unhandledRejection", fatal("unhandledRejection"));

async function listen(httpServer: WebServer, port: number, host: string, attempts = 10): Promise<void> {
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
        httpServer.listen(port, host);
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
  readiness.markSchemaReady();

  const app = createApp();
  // COMPLIANCE (TLS): node:https when certificate files are configured. In
  // production without them, config.ts requires a trusted TLS proxy, and
  // app.ts (HTTP API) and the engine.io transport guard (every Socket.io
  // request, see socket/index.ts) refuse requests that did not use TLS.
  const { server: httpServer, secure } = createListener(app, { certFile: env.TLS_CERT_FILE, keyFile: env.TLS_KEY_FILE });
  const io = createSocketServer(httpServer);
  await tableManager.recover();
  readiness.markRecoveryFinished();

  await listen(httpServer, env.PORT, env.HOST);
  logger.info({ tls: secure ? "direct" : proxyTrust.hops > 0 ? "proxy" : "none", host: env.HOST, port: env.PORT },
    `Poker server listening on ${secure ? "https" : "http"}://${env.HOST}:${env.PORT}`);

  /**
   * Graceful drain: /api/ready answers 503 at once so the load balancer stops
   * routing here; the listener stops accepting; Socket.io clients are
   * disconnected (they reconnect to another process, which reloads the table
   * from Postgres); in-flight HTTP requests get up to DRAIN_TIMEOUT_MS; then
   * table timers stop and the database and Redis connections close.
   */
  let draining = false;
  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    readiness.startDraining();
    logger.info({ signal }, "draining before shutdown");
    try {
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeIdleConnections();
      // io.close() disconnects every socket and closes the engine (and calls
      // httpServer.close again, which is harmless).
      io.close();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        closed.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), DRAIN_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        logger.warn({ timeoutMs: DRAIN_TIMEOUT_MS }, "drain timed out; closing remaining connections");
        httpServer.closeAllConnections();
      }
      tableManager.stop();
      await prisma.$disconnect();
      await disconnectRedis();
      logger.info({ signal }, "shutdown complete");
      process.exit(0);
    } catch (err) {
      fatal("shutdown")(err);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: serializeError(err, env.NODE_ENV !== "production") }, "fatal startup error");
  process.exit(1);
});
