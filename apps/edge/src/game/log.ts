/** Structured logs. Never pass ciphertext, cards, tokens, or cookies. */
export function logEvent(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Prisma messages can echo bound parameters. Log the code only. */
export function prismaCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}
