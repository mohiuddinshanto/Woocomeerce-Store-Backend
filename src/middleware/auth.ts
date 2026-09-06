import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

export type AuthUser = { id: string; name: string; email: string; role: "ADMIN" | "STAFF" | "CUSTOMER"; staffType: "ORDER_MANAGER" | "PRODUCT_MANAGER" | null; allowedCategories: unknown };
declare global { namespace Express { interface Request { user?: AuthUser; sessionToken?: string; } } }

export const makeSessionToken = () => randomBytes(32).toString("hex");
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!session || session.expiresAt <= new Date()) return res.status(401).json({ error: "Session expired" });
  req.user = { id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role, staffType: session.user.staffType, allowedCategories: session.user.allowedCategories };
  req.sessionToken = token;
  next();
}
export function requireRole(...roles: AuthUser["role"][]) { return (req: Request, res: Response, next: NextFunction) => !req.user || !roles.includes(req.user.role) ? res.status(403).json({ error: "Insufficient permissions" }) : next(); }
