import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { verifyAccessToken } from "./jwt.js";

export interface AuthedRequest extends Request {
  userId?: string;
  username?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const claims = verifyAccessToken(token);
    req.userId = claims.sub;
    req.username = claims.username;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

export async function loadUser(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}
