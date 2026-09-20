"use client";

import { useEffect } from "react";
import { SOCKET_EVENTS, verifyTableCards, type PublicTableState, type UserPatchPayload } from "@poker/shared";
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

    };
    let cancelled = false;
    let queue = Promise.resolve();
    const onSnap = (payload: PublicTableState) => {
      if (payload.tableId !== tableId) return;
      queue = queue.then(async () => {
        if (cancelled) return;
        const previous = useTableStore.getState().snapshot;
        if (previous && payload.revision < previous.revision) return;
        if (!await verifyTableCards(payload)) throw new Error("Card verification failed. Reconnect before playing.");
        if (payload.fairness) {
          const key = "poker-commit:" + tableId;
          const commitment = JSON.stringify([payload.handNumber, payload.fairness.root, payload.fairness.dealtSeats]);
          const prior = sessionStorage.getItem(key);
          if (prior) {
            const [hand] = JSON.parse(prior) as [number];
            if (hand === payload.handNumber && prior !== commitment) throw new Error("Deck commitment changed. Stop playing this hand.");
          }
          sessionStorage.setItem(key, commitment);
        }
        if (!cancelled) { setSnapshot(payload); setSocketStatus(payload.fairness ? "cards verified" : "live"); }
      }).catch((err: Error) => {
        setSnapshot(null); setTableError(err.message); setSocketStatus("verification failed");
        socket.disconnect();
      });
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
      cancelled = true;
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
