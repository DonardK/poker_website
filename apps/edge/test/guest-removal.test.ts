/**
 * Guest play was retired (owner decision 2026-10-18): the guest route is
 * gone, and a guest session that survived the migration is refused at every
 * place a session is checked (HTTP authenticate, refresh, the lobby socket
 * and the table socket) with the GUEST_RETIRED end reason.
 */
import { describe, expect, it } from "vitest";
import { endReason } from "../src/auth/sessions";
import { assertLiveSession } from "../src/game/session";
import type { PrismaClient } from "../src/generated/prisma/client";
import { loadSession } from "../src/lobby/auth";
import { cleared, cookieOf, createHarness, PASSWORD, TERMS } from "./harness";

const DAY = 86_400_000;

/** A Prisma stand-in for the socket checks: one session row with its user. */
function prismaWith(row: Record<string, unknown> | null): PrismaClient {
  return { session: { findUnique: async () => row } } as unknown as PrismaClient;
}

function liveRow(user: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    userId: "user-1",
    revokedAt: null,
    revokeReason: null,
    expiresAt: new Date(Date.now() + DAY),
    absoluteExpiresAt: new Date(Date.now() + 30 * DAY),
    user: { id: "user-1", username: "Someone", kind: "HUMAN", isGuest: false, ...user },
    ...extra,
  };
}

describe("guest removal", () => {
  it("POST /api/auth/guest is 404 and creates no user", async () => {
    const { db, request } = createHarness();
    const response = await request("/auth/guest", { body: { ...TERMS, turnstileToken: "test-token" } });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
    expect(db.users.size).toBe(0);
  });

  it("refresh of a live guest session: 401, cookies cleared, row revoked GUEST_RETIRED, sockets told", async () => {
    const h = createHarness();
    const guest = h.db.addUser({ username: "Guest_00aa11bb22", isGuest: true });
    const session = await h.db.addSession(guest.id);
    const response = await h.request("/auth/refresh", { cookie: cookieOf(session.refreshToken) });
    expect(response.status).toBe(401);
    expect(cleared(response)).toBe(true);
    expect(response.cookies.poker_session_hint).toBe("");
    expect(h.db.session(session.id)?.revokeReason).toBe("GUEST_RETIRED");
    expect(h.revoked).toEqual([{ userId: guest.id, sessionId: session.id, reason: "GUEST_RETIRED" }]);
  });

  it("a guest Bearer token is refused by /api/auth/me", async () => {
    const { db, request } = createHarness();
    const guest = db.addUser({ username: "Guest_1234567890", isGuest: true });
    const session = await db.addSession(guest.id);
    expect((await request("/auth/me", { method: "GET", token: session.accessToken })).status).toBe(401);
  });

  it("a guest_ username stays reserved at registration", async () => {
    const { request } = createHarness();
    const response = await request("/auth/register", {
      body: { ...TERMS, username: "Guest_x", email: "guestx@example.com", password: PASSWORD },
    });
    expect([response.status, response.body]).toEqual([409, { error: "Username unavailable" }]);
  });

  it("the lobby socket check revokes a guest session with GUEST_RETIRED", async () => {
    expect(await loadSession(prismaWith(liveRow({ isGuest: true })), "user-1", "sess-1"))
      .toEqual({ ok: false, action: "revoke", reason: "GUEST_RETIRED" });
    const ok = await loadSession(prismaWith(liveRow({})), "user-1", "sess-1");
    expect(ok.ok).toBe(true);
  });

  it("the table socket check refuses a guest session with GUEST_RETIRED", async () => {
    await expect(assertLiveSession(prismaWith(liveRow({ isGuest: true })), "sess-1", "user-1"))
      .rejects.toMatchObject({ name: "AuthError", reason: "GUEST_RETIRED" });
    await expect(assertLiveSession(prismaWith(liveRow({})), "sess-1", "user-1")).resolves.toMatchObject({ userId: "user-1" });
  });

  it("GUEST_RETIRED and SECURITY_LOCKDOWN round-trip through every edge end-reason list", async () => {
    for (const reason of ["GUEST_RETIRED", "SECURITY_LOCKDOWN"] as const) {
      expect(endReason(reason)).toBe(reason);
      const revoked = liveRow({}, { revokedAt: new Date(), revokeReason: reason });
      expect(await loadSession(prismaWith(revoked), "user-1", "sess-1")).toEqual({ ok: false, action: "revoke", reason });
      await expect(assertLiveSession(prismaWith(revoked), "sess-1", "user-1")).rejects.toMatchObject({ reason });
    }
    expect(endReason("SOMETHING_ELSE")).toBe("SESSION_REVOKED");
  });
});
