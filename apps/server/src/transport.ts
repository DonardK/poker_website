/**
 * Transport security (TLS) helpers.
 *
 * COMPLIANCE NOTE (state isolation over TLS): hole cards are emitted only to
 * the owning player's authenticated socket, and in production that socket
 * must run over TLS. The server either terminates TLS itself (node:https with
 * TLS_CERT_FILE / TLS_KEY_FILE, TLS 1.2 minimum) or sits behind a configured
 * number of trusted TLS-terminating proxies (TRUST_PROXY_HOPS >= 1). In
 * production, HTTP requests that fail `isSecureTransport` get 426 (app.ts),
 * and every engine.io request that fails it (the Socket.io handshake, each
 * long-polling request of an open session, and each WebSocket upgrade) is
 * refused by `engineTransportGuard` (socket/index.ts).
 *
 * This module has no side effects and reads no configuration, so it can be
 * tested directly.
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type RequestListener, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { TLSSocket } from "node:tls";

export type WebServer = HttpServer | HttpsServer;

export interface TransportRequest {
  socket: unknown;
  headers: IncomingHttpHeaders;
}

/**
 * True when the request reached this process over TLS: either the socket
 * itself is a TLS socket, or `trustProxyHops >= 1` and the first
 * X-Forwarded-Proto value is "https".
 *
 * With `trustProxyHops` 0 the header is ignored, so a client cannot claim TLS
 * by sending it. With `trustProxyHops >= 1` the header is trusted from ANY
 * peer that connects: this function cannot tell the proxy from a client that
 * reaches the application port directly. Proxy mode is therefore safe only
 * when the application port is reachable ONLY through the TLS-terminating
 * proxy, and the proxy overwrites X-Forwarded-Proto (it must not append to a
 * client-supplied value). Express's `req.protocol` makes the same assumption.
 */
export function isSecureTransport(req: TransportRequest, trustProxyHops: number): boolean {
  if (req.socket instanceof TLSSocket && req.socket.encrypted === true) return true;
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 1) return false;
  const raw = req.headers["x-forwarded-proto"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return false;
  return header.split(",")[0]!.trim().toLowerCase() === "https";
}

/** The request fields a refused engine.io request is reported with. */
export interface EngineTransportRequest extends TransportRequest {
  method?: string | undefined;
  url?: string | undefined;
}

/**
 * engine.io middleware (`io.engine.use`) that refuses every request that did
 * not arrive over TLS. `next(err)` makes engine.io abort the request: an HTTP
 * request gets 400 {"code":3,"message":"Bad request"}, and a WebSocket
 * upgrade gets "HTTP/1.1 400 Bad Request" before its socket is destroyed.
 *
 * Why a middleware and not only `allowRequest`: in engine.io 6.6.10
 * (build/server.js) `allowRequest` is called from `verify()` only for requests
 * WITHOUT a session id, i.e. handshakes. Middlewares run first for EVERY
 * request on the engine.io path: `handleRequest()` (every HTTP request,
 * including long-polling GET/POST that carry a sid) and `handleUpgrade()`
 * (every WebSocket upgrade, with or without a sid) both call
 * `_applyMiddlewares()` and continue to `verify()` only if every middleware
 * called `next()` without an error.
 */
export function engineTransportGuard(trustProxyHops: number, onRefused: (req: EngineTransportRequest) => void):
  (req: EngineTransportRequest, res: unknown, next: (err?: Error) => void) => void {
  return (req, _res, next) => {
    if (isSecureTransport(req, trustProxyHops)) { next(); return; }
    onRefused(req);
    next(new Error("TLS is required"));
  };
}

export interface TlsFiles {
  certFile?: string | undefined;
  keyFile?: string | undefined;
}

/**
 * node:https when both certificate files are configured, node:http otherwise.
 * A missing or unreadable file throws here, so startup fails instead of
 * silently serving plaintext.
 */
export function createListener(handler: RequestListener, tls: TlsFiles): { server: WebServer; secure: boolean } {
  if (Boolean(tls.certFile) !== Boolean(tls.keyFile)) throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither");
  if (tls.certFile && tls.keyFile) {
    const server = createHttpsServer({ cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile), minVersion: "TLSv1.2" }, handler);
    return { server, secure: true };
  }
  return { server: createHttpServer(handler), secure: false };
}
