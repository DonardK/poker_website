type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", fields: Fields, message: string): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(fields: Fields, message: string): void { emit("info", fields, message); }
export function logWarn(fields: Fields, message: string): void { emit("warn", fields, message); }
export function logError(fields: Fields, message: string): void { emit("error", fields, message); }

/** Name and code only. Prisma messages can contain a connection string. */
export function errBrief(err: unknown): { errName: string; errCode?: string } {
  if (!(err instanceof Error)) return { errName: "Unknown" };
  const codeValue = (err as { code?: unknown }).code;
  const code = typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : undefined;
  return { errName: err.name, ...(code ? { errCode: code } : {}) };
}
