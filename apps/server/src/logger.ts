import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { env } from "./config.js";
import { redactPaths, serializeError } from "./security/safe-log.js";

const production = env.NODE_ENV === "production";

/**
 * SECURITY (log hygiene): every error goes through the allow-list serializer
 * (security/safe-log.ts), whether it is logged as `{ err }` or passed as the
 * first argument, and credential-named keys are censored at any depth the
 * redact list covers. Stacks are omitted in production.
 */
export const loggerOptions: LoggerOptions = {
  level: production ? "info" : "debug",
  redact: { paths: redactPaths(), censor: "[REDACTED]" },
  serializers: { err: (err: unknown) => serializeError(err, !production) },
};

/** A logger with the production options writing to `destination` (tests capture output this way). */
export function createLogger(destination: DestinationStream): Logger {
  return pino(loggerOptions, destination);
}

export const logger: Logger = pino({
  ...loggerOptions,
  transport: production
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
});
