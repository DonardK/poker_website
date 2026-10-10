/**
 * OpenNext custom entry. The public host is this Worker (`*.workers.dev`).
 * `/api` and `/ws` are forwarded to the `poker-api` service binding, including
 * WebSocket upgrades. The request URL is unchanged, so the API sees the
 * browser Host and Origin.
 *
 * `.open-next/worker.js` exists after `opennextjs-cloudflare build`.
 */
import { default as handler } from "./.open-next/worker.js";

interface ApiBinding {
  fetch(request: Request): Promise<Response>;
}

function routeToApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/ws" || pathname.startsWith("/ws/");
}

export default {
  async fetch(request: Request, env: { API: ApiBinding }, ctx: ExecutionContext): Promise<Response> {
    if (routeToApi(new URL(request.url).pathname)) return env.API.fetch(request);
    return handler.fetch(request, env, ctx);
  },
};
