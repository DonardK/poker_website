import type { ClientToServerEvents, ServerToClientEvents, SocketData } from "@poker/shared";
import type { Server } from "socket.io";

export type PokerServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
