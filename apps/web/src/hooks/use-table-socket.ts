"use client";

import { useEffect } from "react";
import { SOCKET_EVENTS, type PublicTableState, type UserPatchPayload } from "@poker/shared";
import { getSocket } from "@/lib/socket";
import { useAuthStore, useTableStore } from "@/stores/session";

export function useTableSocket(tableId: string | undefined, accessToken: string | null) {
  const setSnapshot = useTableStore((s) => s.setSnapshot);
  const setSocketStatus = useTableStore((s) => s.setSocketStatus);
  const setTableError = useTableStore((s) => s.setTableError);
  const appendLog = useTableStore((s) => s.appendLog);
  const resetTable = useTableStore((s) => s.resetTable);
  const patchBankroll = useAuthStore((s) => s.patchBankroll);

  useEffect(() => {
    if (!accessToken || !tableId) return;
    resetTable();
    const socket = getSocket(accessToken);

    const onConnect = () => {
      setSocketStatus("connected");
      socket.emit(SOCKET_EVENTS.TABLE_JOIN, { tableId });
      socket.emit(SOCKET_EVENTS.REHYDRATE, { tableId });
    };
    const onSnap = (payload: PublicTableState) => {
      setSnapshot(payload);
      setSocketStatus("live");
    };
    const onAuth = () => setSocketStatus("authenticated");
    const onError = (payload: { code: string; message: string }) => {
      setTableError(payload.message);
      setSocketStatus("error");
    };
    const onPatch = (payload: UserPatchPayload) => patchBankroll(payload.bankroll);

    socket.on("connect", onConnect);
    socket.on(SOCKET_EVENTS.AUTH_OK, onAuth);
    socket.on(SOCKET_EVENTS.STATE_SNAPSHOT, onSnap);
    socket.on(SOCKET_EVENTS.HAND_HISTORY_LOG, appendLog);
    socket.on(SOCKET_EVENTS.SERVER_ERROR, onError);
    socket.on(SOCKET_EVENTS.USER_PATCH, onPatch);

    if (socket.connected) onConnect();
    else socket.connect();

    const watchdog = window.setTimeout(() => {
      const { snapshot, socketStatus } = useTableStore.getState();
      if (!snapshot && socketStatus !== "error") {
        setTableError("Could not join this table. It may have stalled — try another from the lobby.");
      }
    }, 8_000);

    return () => {
      window.clearTimeout(watchdog);
      socket.off("connect", onConnect);
      socket.off(SOCKET_EVENTS.AUTH_OK, onAuth);
      socket.off(SOCKET_EVENTS.STATE_SNAPSHOT, onSnap);
      socket.off(SOCKET_EVENTS.HAND_HISTORY_LOG, appendLog);
      socket.off(SOCKET_EVENTS.SERVER_ERROR, onError);
      socket.off(SOCKET_EVENTS.USER_PATCH, onPatch);
      socket.emit(SOCKET_EVENTS.TABLE_LEAVE, { tableId });
    };
  }, [
    accessToken,
    tableId,
    setSnapshot,
    setSocketStatus,
    setTableError,
    appendLog,
    resetTable,
    patchBankroll,
  ]);
}
