import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

export async function checkIpCooldown(req: Request, res: Response, next: NextFunction) {
  const forwarded = req.headers["x-forwarded-for"];
  const ipAddress = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim() ?? req.ip ?? "127.0.0.1";
  try {
    const config = await prisma.storeConfig.findUnique({ where: { id: "store-config-singleton" } });
    if (!config?.enableIpLimit) return next();
    const lastOrder = await prisma.order.findFirst({ where: { ipAddress }, orderBy: { createdAt: "desc" } });
    if (!lastOrder) return next();
    const waitMs = config.cooldownMinutes * 60_000 - (Date.now() - lastOrder.createdAt.getTime());
    if (waitMs > 0) return res.status(429).json({ error: "Spam Guard Activated", message: `অনুগ্রহ করে ${Math.ceil(waitMs / 60_000)} মিনিট পর আবার চেষ্টা করুন।` });
    next();
  } catch { res.status(500).json({ error: "Spam check failed" }); }
}

export function restrictStaffOrderView(req: Request & { user?: { role: string; allowedCategories?: unknown } }, res: Response, next: NextFunction) {
  if (!req.user || req.user.role === "ADMIN") return next();
  const allowed = Array.isArray(req.user.allowedCategories) ? req.user.allowedCategories.filter((id): id is string => typeof id === "string") : [];
  const originalJson = res.json.bind(res);
  res.json = ((data: unknown) => {
    if (data && typeof data === "object" && "orderItems" in data && Array.isArray(data.orderItems)) {
      const orderItems = data.orderItems.filter((item: unknown) => Boolean(item && typeof item === "object" && "categoryId" in item && allowed.includes(String(item.categoryId))));
      return originalJson({ ...data, orderItems, restrictedSubtotal: orderItems.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0) });
    }
    return originalJson(data);
  }) as Response["json"];
  next();
}
