import { createHash, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { REFRESH_COOKIE_NAME, type PublicUser } from "@poker/shared";
import { z } from "zod";
import type { User } from "@prisma/client";
import { env, isProd } from "../config.js";
import { prisma } from "../db/prisma.js";
import { newOpaqueId } from "../redis/client.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./jwt.js";
import { requireAuth, type AuthedRequest } from "./middleware.js";

export const authRouter = Router();

const usernameSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/);
const passwordSchema = z.string().min(12).max(72).refine((v) => Buffer.byteLength(v, "utf8") <= 72);

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    isGuest: user.isGuest,
    role: user.role,
    kind: user.kind,
    botProfile: user.botProfile,
    bankroll: user.bankroll,
    avatarHue: user.avatarHue,
  };
}

function hashRefresh(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function setRefreshCookie(res: import("express").Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "strict" : "lax",
    path: "/api/auth",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: import("express").Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
}

async function issueSession(user: User, req: import("express").Request, res: import("express").Response) {
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken: newOpaqueId(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      userAgent: req.headers["user-agent"]?.slice(0, 256),
      ip: req.ip,
    },
  });
  const refreshToken = signRefreshToken(user.id, session.id);
  await prisma.session.update({
    where: { id: session.id },
    data: { refreshToken: hashRefresh(refreshToken) },
  });
  setRefreshCookie(res, refreshToken);
  return {
    user: toPublicUser(user),
    accessToken: signAccessToken(user.id, user.username, session.id),
  };
}

authRouter.post("/register", async (req, res) => {
  const parsed = z
    .object({
      username: usernameSchema,
      email: z.string().email().transform((v) => v.toLowerCase()),
      password: passwordSchema,
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration payload" });
    return;
  }
  const { username, email, password } = parsed.data;
  const existing = await prisma.user.findFirst({
    where: { OR: [{ username }, { email }] },
  });
  if (existing) {
    res.status(409).json({ error: "Username or email already in use" });
    return;
  }
  const user = await prisma.user.create({
    data: {
      username,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      bankroll: env.DEFAULT_STARTING_BANKROLL,
      avatarHue: randomInt(360),
    },
  });
  res.status(201).json(await issueSession(user, req, res));
});

authRouter.post("/login", async (req, res) => {
  const parsed = z
    .object({ username: z.string().min(1).max(24), password: z.string().min(1).max(128).refine((v) => Buffer.byteLength(v, "utf8") <= 72) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { username: parsed.data.username } });
  if (!user?.passwordHash || user.kind === "BOT") {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
  res.json(await issueSession(user, req, res));
});

authRouter.post("/guest", async (req, res) => {
  const suffix = newOpaqueId(4).slice(0, 6);
  const user = await prisma.user.create({
    data: {
      username: `Guest_${suffix}`,
      isGuest: true,
      bankroll: env.DEFAULT_STARTING_BANKROLL,
      avatarHue: randomInt(360),
    },
  });
  res.status(201).json(await issueSession(user, req, res));
});

authRouter.post("/refresh", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!token) {
    res.status(401).json({ error: "No refresh session" });
    return;
  }
  try {
    const claims = verifyRefreshToken(token);
    const session = await prisma.session.findUnique({ where: { id: claims.sid } });
    if (!session || session.userId !== claims.sub || session.refreshToken !== hashRefresh(token)) {
      res.status(401).json({ error: "Invalid refresh session" });
      return;
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await prisma.session.delete({ where: { id: session.id } });
      clearRefreshCookie(res);
      res.status(401).json({ error: "Session expired" });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) {
      res.status(401).json({ error: "User missing" });
      return;
    }
    const nextRefresh = signRefreshToken(user.id, session.id);
    const rotated = await prisma.session.updateMany({
      where: { id: session.id, refreshToken: hashRefresh(token) },
      data: { refreshToken: hashRefresh(nextRefresh), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });
    if (rotated.count !== 1) { res.status(401).json({ error: "Session already refreshed" }); return; }
    setRefreshCookie(res, nextRefresh);
    res.json({
      user: toPublicUser(user),
      accessToken: signAccessToken(user.id, user.username, session.id),
    });
  } catch {
    clearRefreshCookie(res);
    res.status(401).json({ error: "Invalid refresh session" });
  }
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (token) {
    try {
      const claims = verifyRefreshToken(token);
      await prisma.session.deleteMany({ where: { id: claims.sid } });
    } catch {
      /* already invalid */
    }
  }
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ user: toPublicUser(user) });
});
