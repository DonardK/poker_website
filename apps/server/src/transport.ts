/**
 * Transport security (TLS) helpers.
 *
 * COMPLIANCE NOTE (state isolation over TLS): hole cards are emitted only to
 * the owning player's authenticated socket, and in production that socket
 * must run over TLS. The server either terminates TLS itself (node:https with
 * TLS_CERT_FILE / TLS_KEY_FILE, TLS 1.2 minimum) or sits behind a configured
 * number of trusted TLS-terminating proxies (TRUST_PROXY_HOPS >= 1). HTTP
 * requests and Socket.io handshakes that fail `isSecureTransport` are refused
 * in production (see app.ts and socket/index.ts).
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
 * itself is a TLS socket, or a trusted TLS-terminating proxy
 * (`trustProxyHops >= 1`) reports "https" as the first X-Forwarded-Proto
 * value. The header is ignored when no proxy is trusted, so a client cannot
 * claim TLS by sending it. The deployment's proxy must overwrite the header
 * (not append to a client-supplied one), as Express's own `req.protocol`
 * also assumes.
 */
export function isSecureTransport(req: TransportRequest, trustProxyHops: number): boolean {
  if (req.socket instanceof TLSSocket && req.socket.encrypted === true) return true;
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 1) return false;
  const raw = req.headers["x-forwarded-proto"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return false;
  return header.split(",")[0]!.trim().toLowerCase() === "https";
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
