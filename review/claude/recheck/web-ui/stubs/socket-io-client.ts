// Test double for socket.io-client: never opens a connection. The harness installs
// globalThis.__makeFakeSocket; without it, io() throws, so no code path can reach the network.
export function io(url: string, options: unknown) {
  const make = (globalThis as any).__makeFakeSocket;
  if (typeof make !== "function") throw new Error("socket.io-client stub: no fake socket factory installed");
  return make(url, options);
}
export type Socket<_A = unknown, _B = unknown> = any;
