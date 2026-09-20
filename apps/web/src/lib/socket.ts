"use client";

import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@poker/shared";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";

export type PokerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: PokerSocket | null = null;
let boundToken: string | null = null;

export function getSocket(accessToken: string): PokerSocket {
  if (socket && boundToken === accessToken) return socket;
  disconnectSocket();
  boundToken = accessToken;
  socket = io(SOCKET_URL, {
    autoConnect: true,
    withCredentials: true,
    auth: { token: accessToken },
    transports: ["websocket", "polling"],
  });
  return socket;
}

export function disconnectSocket(): void {
  if (!socket) {
    boundToken = null;
    return;
  }
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  boundToken = null;
}
