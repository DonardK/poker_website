import type { TableIdleNoticePayload } from "@poker/shared";
import type { Env } from "../env";
import type { RegisterConnection, UnregisterConnection } from "../session/contract";
import type { TableKeepAlivePort } from "./keep-alive";

export interface UserSessionPort {
  register(input: RegisterConnection): Promise<void>;
  unregister(input: UnregisterConnection): Promise<void>;
}

export interface TableIdlePort {
  currentIdleNotice(userId: string): Promise<TableIdleNoticePayload | null>;
}

/**
 * Outbound RPCs. Tests replace `tableKeepAlive` with a fake caller while
 * exercising the lobby without a live table.
 */
export const lobbyPorts = {
  tableKeepAlive(env: Env, tableId: string): TableKeepAlivePort {
    return env.TABLES.getByName(tableId) as DurableObjectStub & TableKeepAlivePort;
  },
  tableIdle(env: Env, tableId: string): TableIdlePort {
    return env.TABLES.getByName(tableId) as DurableObjectStub & TableIdlePort;
  },
  userSessions(env: Env, userId: string): UserSessionPort {
    return env.USER_SESSIONS.getByName(userId) as DurableObjectStub & UserSessionPort;
  },
};
