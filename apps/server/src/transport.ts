/**
 * Transport security (TLS) helpers.
 *
 * COMPLIANCE NOTE (state isolation over TLS): hole cards are emitted only to
 * the owning player's authenticated socket, and in production that socket
 * must run over TLS. The server either terminates TLS itself (node:https with
 * TLS_CERT_FILE / TLS_KEY_FILE, TLS 1.2 minimum) or sits behind a configured
 * number of trusted TLS-terminating proxies (TRUST_PROXY_HOPS >= 1) whose
 * addresses are listed in TRUSTED_PROXY_CIDRS (required in production). In
 * production, HTTP requests that fail `isSecureTransport` get 426 (app.ts),
 * and every engine.io request that fails it (the Socket.io handshake, each
 * long-polling request of an open session, and each WebSocket upgrade) is
 * refused by `engineTransportGuard` (socket/index.ts).
 *
 * This module reads no configuration, so it can be tested directly. Its only
 * state is the process-wide default peer matcher that config.ts registers
 * (setDefaultTrustedPeers).
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type RequestListener, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { BlockList, isIP } from "node:net";
import { TLSSocket } from "node:tls";

export type WebServer = HttpServer | HttpsServer;

export interface TransportRequest {
  socket: unknown;
  headers: IncomingHttpHeaders;
}

/** Matches peer addresses against a list of trusted proxy networks. */
export type PeerMatcher = (address: string | undefined) => boolean;

/**
 * Proxy trust: how many proxy hops to trust, and (optionally) which peer
 * addresses may act as a proxy at all. `trustedPeers` undefined means any
 * peer (the legacy behaviour, development only: config.ts requires
 * TRUSTED_PROXY_CIDRS in production proxy mode).
 */
export interface ProxyTrust {
  hops: number;
  trustedPeers?: PeerMatcher | undefined;
}

/** RFC 1918 + loopback + unique-local IPv6: what TRUSTED_PROXY_CIDRS=private expands to. */
export const PRIVATE_NETWORKS = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"] as const;

/**
 * Parses a comma-separated list of CIDRs and single addresses ("private"
 * expands to PRIVATE_NETWORKS). Throws on any malformed entry, so a typo
 * fails startup instead of silently trusting nothing or everything. IPv4
 * networks also match IPv4-mapped IPv6 peers ("::ffff:10.0.0.5").
 */
export function parseTrustedProxyCidrs(list: string): PeerMatcher {
  const blocks = new BlockList();
  const entries = list.split(",").map((entry) => entry.trim()).filter(Boolean)
    .flatMap((entry) => entry.toLowerCase() === "private" ? [...PRIVATE_NETWORKS] : [entry]);
  if (entries.length === 0) throw new Error("TRUSTED_PROXY_CIDRS is empty");
  for (const entry of entries) {
    const [address, prefixText, extra] = entry.split("/");
    const family = isIP(address ?? "");
    if (!address || family === 0 || extra !== undefined) throw new Error(`TRUSTED_PROXY_CIDRS: "${entry}" is not an IP address or CIDR`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixText === undefined) { blocks.addAddress(address, type); continue; }
    const prefix = Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText) || prefix > (family === 4 ? 32 : 128)) throw new Error(`TRUSTED_PROXY_CIDRS: "${entry}" has an invalid prefix length`);
    blocks.addSubnet(address, prefix, type);
  }
  return (peer) => {
    if (typeof peer !== "string") return false;
    const family = isIP(peer);
    return family !== 0 && blocks.check(peer, family === 4 ? "ipv4" : "ipv6");
  };
}

/**
 * Process-wide peer matcher used when a caller passes a bare hop count.
 * config.ts registers TRUSTED_PROXY_CIDRS here at startup, so callers that
 * still pass `env.TRUST_PROXY_HOPS` (a number) get the peer check as well.
 */
let defaultTrustedPeers: PeerMatcher | undefined;
export function setDefaultTrustedPeers(matcher: PeerMatcher | undefined): void { defaultTrustedPeers = matcher; }

function normalizeTrust(trust: number | ProxyTrust): ProxyTrust {
  return typeof trust === "number" ? { hops: trust, trustedPeers: defaultTrustedPeers } : trust;
}

function peerAddress(socket: unknown): string | undefined {
  const address = (socket as { remoteAddress?: unknown } | null)?.remoteAddress;
  return typeof address === "string" ? address : undefined;
}

/**
 * The value for Express's "trust proxy" setting: false without proxies; the
 * hop count when any peer may be a proxy (development); otherwise a function
 * that trusts an address only within the hop count AND inside the trusted
 * networks. Express calls it for the socket peer (i = 0) and then for each
 * X-Forwarded-For entry from the nearest; the first untrusted address is the
 * client, so req.ip and req.protocol never come from a forged header.
 */
export function expressTrustProxy(trust: ProxyTrust): false | number | ((address: string, i: number) => boolean) {
  if (!Number.isInteger(trust.hops) || trust.hops < 1) return false;
  const { hops, trustedPeers } = trust;
  if (!trustedPeers) return hops;
  return (address, i) => i < hops && trustedPeers(address);
}

/**
 * True when the request reached this process over TLS: either the socket
 * itself is a TLS socket, or proxy mode is on (`hops >= 1`), the immediate
 * peer is a trusted proxy, and the first X-Forwarded-Proto value is "https".
 *
 * With `hops` 0 the header is ignored, so a client cannot claim TLS by
 * sending it. With `hops >= 1` and `trustedPeers` set (TRUSTED_PROXY_CIDRS,
 * required in production), a client that reaches the application port
 * directly from outside those networks cannot claim TLS either. Without
 * `trustedPeers` the header is trusted from ANY peer (development only).
 * The proxy must overwrite X-Forwarded-Proto (not append to a client value).
 * A bare number means `{ hops: n }` with the process-wide matcher registered
 * by config.ts (setDefaultTrustedPeers).
 */
export function isSecureTransport(req: TransportRequest, trust: number | ProxyTrust): boolean {
  if (req.socket instanceof TLSSocket && req.socket.encrypted === true) return true;
  const { hops, trustedPeers } = normalizeTrust(trust);
  if (!Number.isInteger(hops) || hops < 1) return false;
  if (trustedPeers && !trustedPeers(peerAddress(req.socket))) return false;
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
export function engineTransportGuard(trust: number | ProxyTrust, onRefused: (req: EngineTransportRequest) => void):
  (req: EngineTransportRequest, res: unknown, next: (err?: Error) => void) => void {
  return (req, _res, next) => {
    if (isSecureTransport(req, trust)) { next(); return; }
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
