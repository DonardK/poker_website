/**
 * What may reach the logs.
 *
 * SECURITY NOTE (credential leakage through logs): the default pino error
 * serializer copies every enumerable property of an error. body-parser errors
 * carry the raw request body (`err.body`) and, for malformed JSON, a message
 * produced by JSON.parse that quotes the input, so a malformed login request
 * used to write the submitted password to the log. Prisma errors embed the
 * whole invocation, arguments included, in their message. This module
 * therefore serializes errors through an ALLOW-LIST (name, code, a message
 * only where it cannot carry request data, the stack only outside
 * production), and gives pino a redact list as a second line of defence for
 * structured objects that are logged directly.
 *
 * This module imports no configuration, so it can be tested directly.
 */

/** Keys whose values are never written to a log line, at any depth listed by `redactPaths`. */
export const REDACTED_KEYS = [
  "authorization", "cookie", "set-cookie", "password", "newPassword", "token", "refreshToken", "accessToken", "secret", "apiKey",
] as const;

/** Nesting depth covered by the redact paths (pino's redact has no recursive wildcard). */
const REDACT_DEPTH = 5;

/** pino `redact.paths` for every key in REDACTED_KEYS at the top level and up to REDACT_DEPTH levels below it. */
export function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of REDACTED_KEYS) {
    const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
    for (let depth = 0; depth <= REDACT_DEPTH; depth += 1) {
      const prefix = "*.".repeat(depth);
      paths.push(segment.startsWith("[") ? (depth === 0 ? segment : `${prefix.slice(0, -1)}${segment}`) : `${prefix}${segment}`);
    }
  }
  return paths;
}

/**
 * body-parser (express.json) failures. They are client errors: the request
 * body was malformed, too large, or in an unsupported encoding or charset.
 * Their `message` and `body` properties carry the raw input and must never be
 * logged or returned.
 */
export interface BodyParserError { type: string; status: number }

const BODY_PARSER_TYPES = new Set([
  "entity.parse.failed", "entity.too.large", "entity.verify.failed", "encoding.unsupported", "charset.unsupported",
  "request.aborted", "request.size.invalid", "stream.encoding.set", "stream.not.readable", "parameters.too.many",
]);

export function isBodyParserError(err: unknown): err is BodyParserError {
  if (typeof err !== "object" || err === null) return false;
  const { type, status } = err as { type?: unknown; status?: unknown };
  return typeof type === "string" && BODY_PARSER_TYPES.has(type) && typeof status === "number";
}

/** The HTTP status for a body-parser failure: its own 4xx status, otherwise 400. */
export function bodyParserStatus(err: BodyParserError): number {
  return Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 400;
}

/** The fields a serialized error may contain. */
export interface SafeError {
  name: string;
  code?: string | number;
  type?: string;
  status?: number;
  message?: string;
  stack?: string;
  cause?: SafeError;
}

const MAX_MESSAGE = 300;
/** Credential-shaped substrings scrubbed from the messages that are kept. */
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[\w.~+/=-]+/gi,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, // JWTs
  /\b[a-f0-9]{48,}\b/gi, // long hex strings (keys, token hashes)
  /(postgres(?:ql)?|rediss?):\/\/[^\s"']+/gi, // connection URLs carry passwords
];

function scrub(message: string): string {
  let out = message.slice(0, MAX_MESSAGE * 2);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out.slice(0, MAX_MESSAGE);
}

/** Errors whose message is built from request or query data and so is never kept. */
function messageMayCarryInput(err: Record<string, unknown>, name: string): boolean {
  if (isBodyParserError(err)) return true;
  if (name.startsWith("PrismaClient") || name === "SyntaxError") return true;
  return "body" in err || "rawBody" in err;
}

/**
 * Allow-list serializer for errors (used as pino's `err` serializer and by
 * the HTTP catch-all). `includeStack` is false in production: stacks are for
 * debugging, and a production log should carry only what operations needs.
 */
export function serializeError(err: unknown, includeStack: boolean, depth = 0): SafeError {
  if (typeof err !== "object" || err === null) return { name: typeof err === "string" ? "ThrownString" : `Thrown${typeof err}` };
  const record = err as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.length <= 80 ? record.name : (err.constructor?.name ?? "Error").slice(0, 80);
  const out: SafeError = { name };
  if (typeof record.code === "string" && record.code.length <= 64) out.code = record.code;
  else if (typeof record.code === "number" && Number.isFinite(record.code)) out.code = record.code;
  if (isBodyParserError(err)) { out.type = err.type; out.status = err.status; }
  if (!messageMayCarryInput(record, name) && typeof record.message === "string") out.message = scrub(record.message);
  if (includeStack && typeof record.stack === "string") {
    // The stack starts with the (possibly multi-line) message: keep only the
    // "at ..." frames and prefix them with the message as serialized above.
    const frames = record.stack.split("\n").filter((line) => /^\s+at /.test(line));
    out.stack = [out.message === undefined ? name : `${name}: ${out.message}`, ...frames].join("\n").slice(0, 4000);
  }
  if (depth < 2 && record.cause !== undefined) out.cause = serializeError(record.cause, includeStack, depth + 1);
  return out;
}
