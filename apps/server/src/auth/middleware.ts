import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { verifyAccessToken } from "./jwt.js";

export interface AuthedRequest extends Request { userId?: string; username?: string }
export async function authenticate(token: string) {
  const claims = verifyAccessToken(token);
  const session = await prisma.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
  if (!session || session.userId !== claims.sub || session.expiresAt.getTime() <= Date.now() || session.user.kind !== "HUMAN") throw new Error("Unauthorized");
  return { claims, user: session.user };
}
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const { claims } = await authenticate(token);
    req.userId = claims.sub; req.username = claims.username; next();
  } catch { res.status(401).json({ error: "Unauthorized" }); }
}
export async function loadUser(userId: string) { return prisma.user.findUnique({ where: { id: userId } }); }
