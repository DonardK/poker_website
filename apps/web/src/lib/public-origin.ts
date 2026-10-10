/** Trimmed build-time origin, or "" when the workers.dev build left the URL empty. */
export function configuredOrigin(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

/**
 * API origin for browser calls. A non-empty NEXT_PUBLIC_API_URL wins (local
 * `next dev` against the legacy server, and Playwright). Empty means the
 * page origin, so the workers.dev host is not baked in at build time.
 * Server render has no window; callers then use a relative URL.
 */
export function apiOrigin(): string {
  const configured = configuredOrigin(process.env.NEXT_PUBLIC_API_URL);
  if (configured) return configured;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

/** Same rule as {@link apiOrigin} for the WebSocket host. */
export function socketOrigin(): string {
  const configured = configuredOrigin(process.env.NEXT_PUBLIC_SOCKET_URL);
  if (configured) return configured;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
