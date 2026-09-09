import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import multer from "multer";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library.js";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./lib/prisma.js";
import { checkIpCooldown, restrictStaffOrderView } from "./middleware/security.js";
import { makeSessionToken, requireAuth, requireRole } from "./middleware/auth.js";
import { decrypt, encrypt } from "./lib/crypto.js";
import { uploadImage, deleteImage } from "./lib/storage.js";
import { baseSkuForParts, generateVariationsForProduct, makeUniqueSku, replaceProductVariations } from "./lib/product-variations.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:3000" }));
app.use(express.json());
app.use("/uploads", express.static("public/uploads"));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    /^image\//.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only image files are allowed")),
});

const onboardingSchema = z.object({
  storeName: z.string().trim().min(2).max(100),
  adminName: z.string().trim().min(2).max(100),
  adminEmail: z.string().email(),
  password: z.string().min(8).max(128),
  themeSettings: z.object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    font: z.string().min(1).max(100),
  }),
});

const defaultFeatureFlags = { reviews: true, wishlist: true, coupons: true, cod: true, addToCart: true };
const gatewayBase = {
  enabled: z.boolean(),
  mode: z.enum(["sandbox", "live"]).optional(),
  callbackUrl: z.string().url().optional(),
};

const paymentSettingsSchema = z.object({
  bkash: z.object({
    ...gatewayBase,
    appKey: z.string().optional(),
    appSecret: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional(),
  nagad: z.object({
    ...gatewayBase,
    merchantId: z.string().optional(),
    merchantNumber: z.string().optional(),
    privateKey: z.string().optional(),
  }).optional(),
  sslcommerz: z.object({
    ...gatewayBase,
    storeId: z.string().optional(),
    storePassword: z.string().optional(),
    sandbox: z.boolean().optional(),
  }).optional(),
});
type PaymentSettings = z.infer<typeof paymentSettingsSchema>;

const attributeValueSchema = z.object({
  id: z.string().min(1),
  value: z.string().trim().min(1),
  colorSwatch: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
});

const attributeSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  values: z.array(attributeValueSchema).min(1),
});

const variationSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  sku: z.string().nullable().optional(),
  price: z.number().nonnegative(),
  salePrice: z.number().nonnegative().nullable().optional(),
  stock: z.number().int().nonnegative(),
  manageStock: z.boolean().optional(),
  weight: z.number().nonnegative().nullable().optional(),
  image: z.string().nullable().optional(),
  gallery: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  isDefault: z.boolean().optional(),
  attributes: z.array(z.object({ attributeId: z.string().min(1), valueId: z.string().min(1) })).min(1),
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/store/status", async (_req, res) => {
  const config = await prisma.storeConfig.findUnique({
    where: { id: "store-config-singleton" },
    select: {
      isOnboarded: true,
      storeName: true,
      themeSettings: true,
      chatConfig: true,
      marketingPixels: true,
      featureFlags: true,
      homePageConfig: true,
      heroBannerConfig: true,
      navigationConfig: true,
    },
  });
  const configOut = config ? { ...config, featureFlags: { ...defaultFeatureFlags, ...((config.featureFlags as Record<string, boolean> | null) ?? {}) } } : config;
  res.json({ onboarded: Boolean(config?.isOnboarded), config: configOut });
});

app.get("/api/store/checkout-options", async (_req, res) => {
  const config = await prisma.storeConfig.findUnique({
    where: { id: "store-config-singleton" },
    select: { featureFlags: true, paymentConfig: true },
  });
  const flags = { ...defaultFeatureFlags, ...((config?.featureFlags as Record<string, boolean> | null) ?? {}) };
  const encrypted = config?.paymentConfig as { encrypted?: string } | null;
  const payments = encrypted?.encrypted ? (decrypt<PaymentSettings>(encrypted.encrypted) ?? {}) : {};
  const methods = [
    ...(flags.cod ? [{ id: "COD", label: "Cash on delivery" }] : []),
    ...(payments.bkash?.enabled ? [{ id: "bKash", label: "bKash" }] : []),
    ...(payments.nagad?.enabled ? [{ id: "Nagad", label: "Nagad" }] : []),
    ...(payments.sslcommerz?.enabled ? [{ id: "SSLCommerz", label: "Card / Mobile Banking" }] : []),
  ];
  res.json({ methods, codEnabled: flags.cod });
});

app.get("/api/categories", async (_req, res) => {
  const categories = await prisma.category.findMany({
    include: { _count: { select: { products: { where: { isActive: true } } } } },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

app.get("/api/products", async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  let categoryFilter: object = {};
  if (category) {
    const cats = await prisma.category.findMany({ select: { id: true, slug: true, parentId: true } });
    const root = cats.find((c) => c.slug === category);
    if (!root) {
      categoryFilter = { id: "__none__" };
    } else {
      const byParent = new Map<string, string[]>();
      for (const c of cats) {
        if (c.parentId) {
          const arr = byParent.get(c.parentId) ?? [];
          arr.push(c.id);
          byParent.set(c.parentId, arr);
        }
      }
      const ids: string[] = [];
      const stack = [root.id];
      while (stack.length) {
        const cur = stack.pop()!;
        ids.push(cur);
        for (const childId of byParent.get(cur) ?? []) stack.push(childId);
      }
      categoryFilter = { categoryId: { in: ids } };
    }
  }
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      ...categoryFilter,
    },
    select: {
      id: true,
      slug: true,
      name: true,
      price: true,
      salePrice: true,
      stock: true,
      productType: true,
      sku: true,
      description: true,
      images: true,
      defaultVariationId: true,
      imagesDetails: { orderBy: { sortOrder: "asc" } },
      category: { select: { name: true, slug: true } },
      _count: { select: { reviews: { where: { isApproved: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(products);
});

app.get("/api/products/:slug", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { slug: req.params.slug },
    include: {
      category: { select: { name: true, slug: true } },
      imagesDetails: { orderBy: { sortOrder: "asc" } },
      attributes: { include: { values: true }, orderBy: { createdAt: "asc" } },
      variations: {
        include: { attributes: { include: { attribute: { select: { id: true, name: true } }, value: true } } },
        orderBy: { createdAt: "asc" },
      },
      reviews: {
        where: { isApproved: true },
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!product?.isActive) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });

app.post("/api/auth/sign-up", async (req, res) => {
  const data = credentialsSchema.extend({ name: z.string().trim().min(2).max(100) }).safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid registration data" });
  if (await prisma.user.findUnique({ where: { email: data.data.email } })) return res.status(409).json({ error: "Email already registered" });
  const user = await prisma.user.create({
    data: { name: data.data.name, email: data.data.email, passwordHash: await bcrypt.hash(data.data.password, 12) },
  });
  const token = makeSessionToken();
  await prisma.session.create({ data: { userId: user.id, token, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post("/api/auth/sign-in", async (req, res) => {
  const data = credentialsSchema.safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid credentials" });
  const user = await prisma.user.findUnique({ where: { email: data.data.email } });
  if (!user || !(await bcrypt.compare(data.data.password, user.passwordHash)))
    return res.status(401).json({ error: "Incorrect email or password" });
  const token = makeSessionToken();
  await prisma.session.create({ data: { userId: user.id, token, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get("/api/auth/me", requireAuth, async (req, res) => res.json({ user: req.user }));
app.post("/api/auth/sign-out", requireAuth, async (req, res) => {
  await prisma.session.delete({ where: { token: req.sessionToken } });
  res.status(204).end();
});

// Customer Wishlist
app.get("/api/wishlist", requireAuth, async (req, res) =>
  res.json(await prisma.wishlist.findMany({ where: { userId: req.user!.id }, include: { product: { include: { category: true } } } }))
);
app.post("/api/wishlist/:productId", requireAuth, async (req, res) => {
  const productId = String(req.params.productId);
  const where = { userId_productId: { userId: req.user!.id, productId } };
  const existing = await prisma.wishlist.findUnique({ where });
  if (existing) {
    await prisma.wishlist.delete({ where });
    return res.status(204).end();
  }
  await prisma.wishlist.create({ data: { userId: req.user!.id, productId } });
  res.status(201).json({ saved: true });
});

// Product Reviews
app.post("/api/products/:productId/reviews", requireAuth, async (req, res) => {
  const data = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }).safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid review" });
  const productId = String(req.params.productId);
  const review = await prisma.review.upsert({
    where: { productId_userId: { productId, userId: req.user!.id } },
    update: { rating: data.data.rating, comment: data.data.comment, isApproved: false },
    create: { rating: data.data.rating, comment: data.data.comment, productId, userId: req.user!.id, isApproved: false },
  });
  res.status(201).json(review);
});

app.get("/api/account/orders", requireAuth, async (req, res) => {
  res.json(await prisma.order.findMany({ where: { customerId: req.user!.id }, orderBy: { createdAt: "desc" } }));
});

// Coupons Validation API
app.post("/api/coupons/validate", async (req, res) => {
  const data = z.object({ code: z.string().trim().toUpperCase(), subtotal: z.number().nonnegative(), categoryIds: z.array(z.string()).default([]) }).safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid coupon request" });
  const coupon = await prisma.coupon.findUnique({ where: { code: data.data.code } });
  const now = new Date();
  if (
    !coupon ||
    !coupon.isActive ||
    (coupon.startsAt && coupon.startsAt > now) ||
    (coupon.expiresAt && coupon.expiresAt < now) ||
    (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) ||
    (coupon.minSpend && data.data.subtotal < Number(coupon.minSpend))
  )
    return res.status(404).json({ error: "Coupon is invalid or expired" });

  const permitted = !coupon.applicableCategoryIds || (coupon.applicableCategoryIds as string[]).some((id) => data.data.categoryIds.includes(id));
  if (!permitted) return res.status(400).json({ error: "Coupon does not apply to items in your cart" });

  const raw = coupon.type === "PERCENTAGE" ? (data.data.subtotal * Number(coupon.value)) / 100 : Number(coupon.value);
  const discount = Math.min(raw, coupon.maxDiscount ? Number(coupon.maxDiscount) : raw);
  res.json({ id: coupon.id, code: coupon.code, discount });
});

// Onboarding
app.post("/api/onboarding", async (req, res) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid onboarding data", issues: parsed.error.flatten() });
  const existing = await prisma.storeConfig.findUnique({ where: { id: "store-config-singleton" } });
  if (existing?.isOnboarded) return res.status(403).json({ error: "Onboarding is already complete" });
  const duplicateAdmin = await prisma.user.findUnique({ where: { email: parsed.data.adminEmail } });
  if (duplicateAdmin) return res.status(409).json({ error: "An account with this email already exists" });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await prisma.$transaction([
    prisma.user.create({ data: { name: parsed.data.adminName, email: parsed.data.adminEmail, passwordHash, role: "ADMIN" } }),
    prisma.storeConfig.upsert({
      where: { id: "store-config-singleton" },
      update: { storeName: parsed.data.storeName, themeSettings: parsed.data.themeSettings, featureFlags: defaultFeatureFlags, isOnboarded: true },
      create: { id: "store-config-singleton", storeName: parsed.data.storeName, themeSettings: parsed.data.themeSettings, featureFlags: defaultFeatureFlags, isOnboarded: true },
    }),
  ]);
  res.status(201).json({ message: "Store onboarding completed" });
});

// Create Order API
app.post("/api/orders", checkIpCooldown, async (req, res) => {
  const schema = z.object({
    paymentMethod: z.string().min(2),
    subtotal: z.number().nonnegative(),
    shippingCharge: z.number().nonnegative().default(0),
    discountAmount: z.number().nonnegative().optional(),
    couponId: z.string().optional(),
    totalAmount: z.number().nonnegative(),
    shippingDetails: z.record(z.string(), z.unknown()),
    orderItems: z
      .array(
        z.object({
          productId: z.string(),
          name: z.string(),
          qty: z.number().int().positive(),
          price: z.number().nonnegative(),
          categoryId: z.string(),
          variationId: z.string().optional(),
          sku: z.string().optional(),
        })
      )
      .min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid order payload", issues: parsed.error.flatten() });

  const customerId = req.header("authorization")
    ? (await prisma.session.findUnique({ where: { token: req.header("authorization")!.replace(/^Bearer\s+/i, "") } }))?.userId
    : undefined;

  const order = await prisma.$transaction(async (tx) => {
    // Decrement stock for each order item (product-level + variation-level)
    for (const item of parsed.data.orderItems) {
      if (item.variationId) {
        const variation = await tx.productVariation.findUnique({ where: { id: item.variationId }, select: { productId: true, stock: true, manageStock: true } });
        if (variation && variation.manageStock !== false) {
          await tx.productVariation.update({
            where: { id: item.variationId },
            data: { stock: Math.max(0, variation.stock - item.qty) },
          });
        }
      }
      const product = await tx.product.findUnique({ where: { id: item.productId }, select: { stock: true, productType: true } });
      if (product && product.productType !== "VARIABLE") {
        await tx.product.update({ where: { id: item.productId }, data: { stock: Math.max(0, product.stock - item.qty) } });
      }
    }

    return tx.order.create({
      data: {
        ...parsed.data,
        shippingDetails: parsed.data.shippingDetails as Prisma.InputJsonValue,
        orderItems: parsed.data.orderItems as Prisma.InputJsonValue,
        ipAddress: req.ip ?? "127.0.0.1",
        customerId,
      },
    });
  });

  if (parsed.data.couponId) {
    await prisma.coupon.update({ where: { id: parsed.data.couponId }, data: { usedCount: { increment: 1 } } }).catch(() => {});
  }

  res.status(201).json(order);
});

// --- ADMIN API ENDPOINTS ---

app.get("/api/admin/dashboard", requireAuth, requireRole("ADMIN", "STAFF"), async (_req, res) => {
  const [products, orders, customers, revenue] = await Promise.all([
    prisma.product.count(),
    prisma.order.count(),
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.order.aggregate({ _sum: { totalAmount: true }, where: { paymentStatus: "PAID" } }),
  ]);
  res.json({ products, orders, customers, paidRevenue: revenue._sum.totalAmount ?? 0 });
});

app.get("/api/admin/products", requireAuth, requireRole("ADMIN", "STAFF"), async (_req, res) => {
  res.json(
    await prisma.product.findMany({
      include: {
        category: { select: { name: true } },
        imagesDetails: { orderBy: { sortOrder: "asc" } },
        attributes: { include: { values: true } },
        variations: { include: { attributes: true }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { updatedAt: "desc" },
    })
  );
});

app.patch("/api/admin/products/:id", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const id = String(req.params.id);
  const data = z
    .object({
      name: z.string().min(2).optional(),
      price: z.number().nonnegative().optional(),
      salePrice: z.number().nonnegative().nullable().optional(),
      longDescription: z.string().nullable().optional(),
      stock: z.number().int().nonnegative().optional(),
      isActive: z.boolean().optional(),
      showOnHome: z.boolean().optional(),
      productType: z.enum(["SIMPLE", "VARIABLE"]).optional(),
      sku: z.string().trim().max(100).nullable().optional(),
      defaultVariationId: z.string().nullable().optional(),
      images: z.array(z.string().url().or(z.string().regex(/^\//))).optional(),
      imageDetails: z.array(z.object({ url: z.string(), altText: z.string().nullable().optional(), title: z.string().nullable().optional(), sortOrder: z.number().int().nonnegative().optional(), isFeatured: z.boolean().optional() })).optional(),
      attributes: z.array(attributeSchema).optional(),
      variations: z.array(variationSchema).optional(),
      productAttributes: z.unknown().optional(),
      variants: z.unknown().optional(),
      variationImages: z.unknown().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid product update", details: data.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });

  let { imageDetails, images, variationImages, attributes, variations, defaultVariationId, ...rest } = data.data;

  if (rest.sku === null) rest.sku = undefined;

  if (variations !== undefined && attributes !== undefined) {
    await replaceProductVariations(id, attributes, variations, rest.sku || undefined);
  } else if (defaultVariationId !== undefined) {
    await prisma.product.update({ where: { id }, data: { defaultVariationId: defaultVariationId || null } });
  } else if (rest.productType === "SIMPLE") {
    const existingVariations = await prisma.productVariation.count({ where: { productId: id } });
    if (existingVariations) {
      await prisma.$transaction([
        prisma.productVariation.deleteMany({ where: { productId: id } }),
        prisma.productAttribute.deleteMany({ where: { productId: id } }),
        prisma.product.update({ where: { id }, data: { defaultVariationId: null } }),
      ]);
    }
  }

  if (imageDetails && imageDetails.length) {
    const sorted = [...imageDetails].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const hasFeatured = sorted.some((i) => i.isFeatured);
    const normalized = sorted.map((i, index) => ({ url: i.url, altText: i.altText ?? null, title: i.title ?? null, sortOrder: index, isFeatured: !hasFeatured ? index === 0 : Boolean(i.isFeatured) }));
    res.json(
      await prisma.$transaction([
        prisma.productImage.deleteMany({ where: { productId: id } }),
        prisma.product.update({
          where: { id },
          data: {
            ...(rest as object),
            images: normalized.filter((i) => i.isFeatured).concat(normalized.filter((i) => !i.isFeatured)).map((i) => i.url) as unknown as Prisma.InputJsonValue,
            ...(variationImages !== undefined ? { variationImages: variationImages as Prisma.InputJsonValue } : {}),
            imagesDetails: { create: normalized },
          },
        }),
      ])
    );
    return;
  }

  res.json(
    await prisma.product.update({
      where: { id },
      data: {
        ...(rest as object),
        ...(images ? { images: images as unknown as Prisma.InputJsonValue } : {}),
        ...(variationImages !== undefined ? { variationImages: variationImages as Prisma.InputJsonValue } : {}),
      },
    })
  );
});

app.delete("/api/admin/products/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  await prisma.product.delete({ where: { id: String(req.params.id) } });
  res.status(204).end();
});

app.get("/api/admin/categories", requireAuth, requireRole("ADMIN", "STAFF"), async (_req, res) =>
  res.json(await prisma.category.findMany({ include: { subCategories: { orderBy: { name: "asc" } } }, orderBy: { name: "asc" } }))
);

app.get("/api/admin/orders", requireAuth, requireRole("ADMIN", "STAFF"), restrictStaffOrderView, async (_req, res) => {
  res.json(await prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 100 }));
});

app.patch("/api/admin/orders/:id", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const data = z
    .object({
      status: z.enum(["PENDING", "CONFIRMED", "PACKED", "SENT", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"]).optional(),
      paymentStatus: z.enum(["UNPAID", "PAID", "FAILED", "REFUNDED"]).optional(),
      courierName: z.string().max(100).nullable().optional(),
      courierTrackingId: z.string().max(200).nullable().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid order update" });
  res.json(await prisma.order.update({ where: { id: String(req.params.id) }, data: data.data }));
});

app.post("/api/admin/categories", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const data = z
    .object({
      name: z.string().trim().min(2),
      slug: z.string().regex(/^[a-z0-9-]+$/),
      parentId: z.string().optional(),
      attributeSchema: z.unknown().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid category" });
  res.status(201).json(await prisma.category.create({ data: { ...data.data, attributeSchema: data.data.attributeSchema as Prisma.InputJsonValue } }));
});

app.patch("/api/admin/categories/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const data = z
    .object({
      name: z.string().trim().min(2).optional(),
      slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
      parentId: z.string().nullable().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid category update" });
  res.json(await prisma.category.update({ where: { id: String(req.params.id) }, data: data.data }));
});

app.delete("/api/admin/categories/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const id = String(req.params.id);
  const count = await prisma.product.count({ where: { categoryId: id } });
  if (count > 0) return res.status(400).json({ error: "Cannot delete: products exist in this category" });
  const children = await prisma.category.count({ where: { parentId: id } });
  if (children > 0) return res.status(400).json({ error: "Cannot delete: this category has sub-categories" });
  await prisma.category.delete({ where: { id } });
  res.status(204).end();
});

app.post("/api/admin/products", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const data = z
    .object({
      categoryId: z.string(),
      name: z.string().min(2),
      slug: z.string().regex(/^[a-z0-9-]+$/),
      description: z.string().min(10),
      longDescription: z.string().optional(),
      price: z.number().nonnegative(),
      salePrice: z.number().nonnegative().optional(),
      stock: z.number().int().nonnegative(),
      sku: z.string().trim().max(100).optional(),
      productType: z.enum(["SIMPLE", "VARIABLE"]).optional(),
      images: z.array(z.string().url().or(z.string().regex(/^\//))).min(1),
      imageDetails: z.array(z.object({ url: z.string(), altText: z.string().nullable().optional(), title: z.string().nullable().optional(), sortOrder: z.number().int().nonnegative().optional(), isFeatured: z.boolean().optional() })).optional(),
      attributes: z.array(attributeSchema).optional(),
      variations: z.array(variationSchema).optional(),
      productAttributes: z.unknown().optional(),
      variants: z.unknown().optional(),
      variationImages: z.unknown().optional(),
      isPerishable: z.boolean().optional(),
      showOnHome: z.boolean().optional(),
      expiryDate: z.string().datetime().optional(),
    })
    .safeParse(req.body);
  if (!data.success) {
    return res.status(400).json({ error: "Invalid product", details: data.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  const { expiryDate, variationImages, imageDetails, attributes, variations, ...product } = data.data;
  try {
    const imagesArr = product.images as string[];
    const sorted = imageDetails && imageDetails.length
      ? [...imageDetails].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      : imagesArr.map((url, index) => ({ url, altText: null as string | null, title: null as string | null, sortOrder: index, isFeatured: index === 0 }));
    const hasFeatured = sorted.some((i) => i.isFeatured);
    const normalizedDetails = sorted.length
      ? sorted.map((i, index) => ({ url: i.url, altText: i.altText, title: i.title, sortOrder: index, isFeatured: !hasFeatured ? index === 0 : Boolean(i.isFeatured) }))
      : imagesArr.map((url, index) => ({ url, altText: null as string | null, title: null as string | null, sortOrder: index, isFeatured: index === 0 }));
    const created = await prisma.product.create({
      data: {
        ...product,
        images: normalizedDetails.filter((i) => i.isFeatured).concat(normalizedDetails.filter((i) => !i.isFeatured)).map((i) => i.url) as unknown as Prisma.InputJsonValue,
        productAttributes: (product as { productAttributes?: unknown }).productAttributes as Prisma.InputJsonValue,
        variants: (product as { variants?: unknown }).variants as Prisma.InputJsonValue,
        variationImages: variationImages as Prisma.InputJsonValue,
        imagesDetails: { create: normalizedDetails },
        expiryDate: expiryDate ? new Date(expiryDate) : undefined,
      },
    });
    if (attributes && variations) {
      await replaceProductVariations(created.id, attributes, variations, product.sku || undefined);
    }
    const result = await prisma.product.findUnique({
      where: { id: created.id },
      include: { category: { select: { name: true } }, imagesDetails: { orderBy: { sortOrder: "asc" } }, attributes: { include: { values: true } }, variations: { include: { attributes: true } } },
    });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
      return res.status(409).json({ error: "A product with this slug already exists - change the product name or slug" });
    }
    throw error;
  }
});

app.post("/api/admin/upload", requireAuth, requireRole("ADMIN", "STAFF"), upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No image file provided" });
  try {
    const url = await uploadImage(file);
    res.status(201).json({ url });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to upload image" });
  }
});

// Product image management (gallery CRUD)
// GET  /api/admin/products/:id/images
// POST /api/admin/products/:id/images        { urls: string[] }  (attach existing uploaded images)
// PATCH /api/admin/products/images/:imgId    { altText?, title?, isFeatured?, sortOrder? }
// POST /api/admin/products/images/:imgId/toggle-featured
// DELETE /api/admin/products/:id/images/:imgId

async function syncProductImages(productId: string) {
  const rows = await prisma.productImage.findMany({ where: { productId }, orderBy: { sortOrder: "asc" } });
  const featuredFirst = rows.filter((r) => r.isFeatured).concat(rows.filter((r) => !r.isFeatured));
  await prisma.product.update({
    where: { id: productId },
    data: { images: featuredFirst.map((r) => r.url) as unknown as Prisma.InputJsonValue },
  });
  return rows;
}

app.get("/api/admin/products/:id/images", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const images = await prisma.productImage.findMany({
    where: { productId: String(req.params.id) },
    orderBy: { sortOrder: "asc" },
  });
  res.json(images);
});

app.post("/api/admin/products/:id/images", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const data = z.object({ urls: z.array(z.string().url().or(z.string().regex(/^\//))).min(1) }).safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid image payload" });
  const productId = String(req.params.id);
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) return res.status(404).json({ error: "Product not found" });
  const nextOrder = await prisma.productImage.count({ where: { productId } });
  await prisma.productImage.createMany({
    data: data.data.urls.map((url, index) => ({
      productId,
      url,
      sortOrder: nextOrder + index,
      isFeatured: nextOrder + index === 0,
    })),
  });
  const rows = await syncProductImages(productId);
  res.status(201).json(rows);
});

app.patch("/api/admin/products/images/:imgId", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const data = z
    .object({
      altText: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      isFeatured: z.boolean().optional(),
      sortOrder: z.number().int().nonnegative().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid image update" });
  const img = await prisma.productImage.update({ where: { id: String(req.params.imgId) }, data: data.data });
  if (data.data.isFeatured === true) {
    await prisma.productImage.updateMany({ where: { productId: img.productId, id: { not: img.id } }, data: { isFeatured: false } });
  }
  await syncProductImages(img.productId);
  res.json(await prisma.productImage.findMany({ where: { productId: img.productId }, orderBy: { sortOrder: "asc" } }));
});

app.post("/api/admin/products/images/:imgId/toggle-featured", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const img = await prisma.productImage.findUnique({ where: { id: String(req.params.imgId) } });
  if (!img) return res.status(404).json({ error: "Image not found" });
  await prisma.productImage.updateMany({ where: { productId: img.productId }, data: { isFeatured: false } });
  await prisma.productImage.update({ where: { id: img.id }, data: { isFeatured: true } });
  await syncProductImages(img.productId);
  res.json(await prisma.productImage.findMany({ where: { productId: img.productId }, orderBy: { sortOrder: "asc" } }));
});

app.delete("/api/admin/products/:id/images/:imgId", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const img = await prisma.productImage.findUnique({ where: { id: String(req.params.imgId) } });
  if (!img || img.productId !== String(req.params.id)) return res.status(404).json({ error: "Image not found" });
  await prisma.productImage.delete({ where: { id: img.id } });
  await deleteImage(img.url);
  const remaining = await syncProductImages(img.productId);
  if (remaining.length > 0) {
    const hasFeatured = remaining.some((r) => r.isFeatured);
    if (!hasFeatured) {
      await prisma.productImage.update({ where: { id: remaining[0].id }, data: { isFeatured: true } });
      await syncProductImages(img.productId);
    }
  }
  res.status(204).end();
});

// Product Variations Management
const variationInclude = { attributes: { include: { attribute: { select: { id: true, name: true } }, value: true } } } as const;

app.post("/api/admin/products/:id/generate-variations", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const id = String(req.params.id);
  const data = z
    .object({
      attributes: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), values: z.array(z.object({ id: z.string().min(1), value: z.string().min(1) })).min(1) })).min(1),
      basePrice: z.number().nonnegative().optional(),
      baseStock: z.number().int().nonnegative().optional(),
      skuPrefix: z.string().trim().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid generate request", details: data.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return res.status(404).json({ error: "Product not found" });

  const attrDetails = await prisma.productAttribute.findMany({ where: { productId: id }, include: { values: true } });
  const attrTempMap = new Map<string, string>();
  data.data.attributes.forEach((a) => {
    const real = attrDetails.find((ad) => ad.name.toLowerCase() === a.name.trim().toLowerCase());
    attrTempMap.set(a.id, real?.id ?? "");
    a.values.forEach((v) => {
      const realVal = real?.values.find((rv) => rv.value.toLowerCase() === v.value.trim().toLowerCase());
      if (realVal) v.id = realVal.id;
    });
  });

  const { created } = await generateVariationsForProduct(
    id,
    data.data.attributes.map((a) => ({ id: attrTempMap.get(a.id) || a.id, name: a.name, values: a.values })),
    { basePrice: data.data.basePrice ?? Number(product.price), baseStock: data.data.baseStock ?? 0, skuPrefix: data.data.skuPrefix || product.sku || undefined }
  );

  res.status(201).json({ created, variations: await prisma.productVariation.findMany({ where: { productId: id }, include: variationInclude, orderBy: { createdAt: "asc" } }) });
});

app.patch("/api/admin/products/variations/:vid", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const vid = String(req.params.vid);
  const data = z
    .object({
      name: z.string().trim().min(1).optional(),
      sku: z.string().trim().max(100).nullable().optional(),
      price: z.number().nonnegative().optional(),
      salePrice: z.number().nonnegative().nullable().optional(),
      stock: z.number().int().nonnegative().optional(),
      manageStock: z.boolean().optional(),
      weight: z.number().nonnegative().nullable().optional(),
      image: z.string().nullable().optional(),
      gallery: z.array(z.string()).optional(),
      description: z.string().nullable().optional(),
      status: z.enum(["active", "disabled"]).optional(),
      isDefault: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid variation update" });

  let skuFinal: string | null | undefined;
  if (data.data.sku !== undefined) {
    const trim = data.data.sku?.trim();
    if (trim) {
      const existing = await prisma.productVariation.findFirst({ where: { sku: trim.toUpperCase(), id: { not: vid } }, select: { id: true } });
      if (existing) return res.status(409).json({ error: "SKU already in use by another variation" });
      skuFinal = trim.toUpperCase();
    } else {
      skuFinal = null;
    }
  }

  const { isDefault, ...rest } = data.data;
  const variation = await prisma.productVariation.update({ where: { id: vid }, data: { ...rest, ...(skuFinal !== undefined ? { sku: skuFinal } : {}), gallery: rest.gallery ? (rest.gallery as Prisma.InputJsonValue) : undefined } });

  if (isDefault === true) {
    await prisma.product.update({ where: { id: variation.productId }, data: { defaultVariationId: variation.id } });
  } else if (isDefault === false && variation.productId) {
    const prod = await prisma.product.findUnique({ where: { id: variation.productId }, select: { defaultVariationId: true } });
    if (prod?.defaultVariationId === variation.id) {
      await prisma.product.update({ where: { id: variation.productId }, data: { defaultVariationId: null } });
    }
  }

  res.json(await prisma.productVariation.findUnique({ where: { id: vid }, include: variationInclude }));
});

app.post("/api/admin/products/variations/:vid/duplicate", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const vid = String(req.params.vid);
  const source = await prisma.productVariation.findUnique({ where: { id: vid }, include: { attributes: true } });
  if (!source) return res.status(404).json({ error: "Variation not found" });
  const sku = await makeUniqueSku(source.sku ? `${source.sku}-COPY` : "VAR");
  const created = await prisma.productVariation.create({
    data: {
      productId: source.productId,
      name: `${source.name} (Copy)`,
      sku,
      price: source.price,
      salePrice: source.salePrice,
      stock: source.stock,
      manageStock: source.manageStock,
      weight: source.weight,
      image: source.image,
      gallery: source.gallery as Prisma.InputJsonValue | undefined,
      description: source.description,
      status: source.status,
      attributes: { create: source.attributes.map((a) => ({ attributeId: a.attributeId, valueId: a.valueId })) },
    },
  });
  res.status(201).json(created);
});

app.delete("/api/admin/products/variations/:vid", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const variation = await prisma.productVariation.findUnique({ where: { id: String(req.params.vid) }, select: { id: true, productId: true, image: true } });
  if (!variation) return res.status(404).json({ error: "Variation not found" });
  await prisma.productVariation.delete({ where: { id: variation.id } });
  if (variation.image) await deleteImage(variation.image);
  const prod = await prisma.product.findUnique({ where: { id: variation.productId }, select: { defaultVariationId: true } });
  if (prod?.defaultVariationId === variation.id) {
    const first = await prisma.productVariation.findFirst({ where: { productId: variation.productId }, orderBy: { createdAt: "asc" } });
    await prisma.product.update({ where: { id: variation.productId }, data: { defaultVariationId: first?.id ?? null } });
  }
  res.status(204).end();
});

app.post("/api/admin/products/:id/variations/bulk", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const productId = String(req.params.id);
  const data = z
    .object({
      ids: z.array(z.string()).min(1),
      action: z.enum(["setPrice", "setSalePrice", "setStock", "setStatus", "enable", "disable", "delete"]),
      value: z.number().nonnegative().optional().or(z.enum(["active", "disabled"])).or(z.unknown()),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid bulk action" });

  const { ids, action, value } = data.data;

  if (action === "delete") {
    const rows = await prisma.productVariation.findMany({ where: { id: { in: ids }, productId }, select: { id: true, image: true } });
    await prisma.productVariation.deleteMany({ where: { id: { in: ids }, productId } });
    for (const row of rows) if (row.image) await deleteImage(row.image);
  } else if (action === "setPrice") {
    await prisma.productVariation.updateMany({ where: { id: { in: ids }, productId }, data: { price: value as number } });
  } else if (action === "setSalePrice") {
    await prisma.productVariation.updateMany({ where: { id: { in: ids }, productId }, data: { salePrice: value === 0 ? null : (value as number) } });
  } else if (action === "setStock") {
    await prisma.productVariation.updateMany({ where: { id: { in: ids }, productId }, data: { stock: value as number } });
  } else if (action === "setStatus") {
    await prisma.productVariation.updateMany({ where: { id: { in: ids }, productId }, data: { status: value === "disabled" ? "disabled" : "active" } });
  } else if (action === "enable") {
    await prisma.productVariation.updateMany({ where: { id: { in: ids }, productId }, data: { status: "active" } });
  } else if (action === "disable") {
    await prisma.productVariation.updateMany({ where: { id: { in: ids }, productId }, data: { status: "disabled" } });
  }

  res.json(await prisma.productVariation.findMany({ where: { productId }, include: variationInclude, orderBy: { createdAt: "asc" } }));
});

// Admin Coupons Management APIs
app.get("/api/admin/coupons", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  res.json(await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } }));
});

app.post("/api/admin/coupons", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const data = z
    .object({
      code: z.string().trim().toUpperCase().min(3),
      type: z.enum(["PERCENTAGE", "FLAT"]),
      value: z.number().positive(),
      minSpend: z.number().nonnegative().optional(),
      maxDiscount: z.number().nonnegative().optional(),
      usageLimit: z.number().int().positive().optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid coupon data" });

  const coupon = await prisma.coupon.create({ data: data.data });
  res.status(201).json(coupon);
});

app.delete("/api/admin/coupons/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  await prisma.coupon.delete({ where: { id: String(req.params.id) } });
  res.status(204).end();
});

// Admin Reviews Moderation APIs
app.get("/api/admin/reviews", requireAuth, requireRole("ADMIN", "STAFF"), async (_req, res) => {
  res.json(await prisma.review.findMany({ include: { product: { select: { name: true } }, user: { select: { name: true, email: true } } }, orderBy: { createdAt: "desc" } }));
});

app.patch("/api/admin/reviews/:id", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  const data = z.object({ isApproved: z.boolean() }).safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid review update" });
  res.json(await prisma.review.update({ where: { id: String(req.params.id) }, data: data.data }));
});

app.delete("/api/admin/reviews/:id", requireAuth, requireRole("ADMIN", "STAFF"), async (req, res) => {
  await prisma.review.delete({ where: { id: String(req.params.id) } });
  res.status(204).end();
});

// Admin Staff Management APIs
app.get("/api/admin/staff", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  res.json(await prisma.user.findMany({ where: { role: "STAFF" }, select: { id: true, name: true, email: true, role: true, staffType: true, allowedCategories: true, createdAt: true } }));
});

app.post("/api/admin/staff", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const data = z
    .object({
      name: z.string().trim().min(2),
      email: z.string().email(),
      password: z.string().min(8),
      staffType: z.enum(["ORDER_MANAGER", "PRODUCT_MANAGER"]),
      allowedCategories: z.array(z.string()).optional(),
    })
    .safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: "Invalid staff payload" });

  const existing = await prisma.user.findUnique({ where: { email: data.data.email } });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = await bcrypt.hash(data.data.password, 12);
  const staff = await prisma.user.create({
    data: {
      name: data.data.name,
      email: data.data.email,
      passwordHash,
      role: "STAFF",
      staffType: data.data.staffType,
      allowedCategories: data.data.allowedCategories ? (JSON.stringify(data.data.allowedCategories) as Prisma.InputJsonValue) : undefined,
    },
  });

  res.status(201).json({ id: staff.id, name: staff.name, email: staff.email, role: staff.role });
});

app.delete("/api/admin/staff/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  await prisma.user.delete({ where: { id: String(req.params.id) } });
  res.status(204).end();
});

app.patch("/api/admin/config", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const data = z
    .object({
      storeName: z.string().min(2).max(100).optional(),
      logoUrl: z.string().url().optional(),
      themeSettings: z.unknown().optional(),
      featureFlags: z.object({ reviews: z.boolean().optional(), wishlist: z.boolean().optional(), coupons: z.boolean().optional(), cod: z.boolean().optional(), addToCart: z.boolean().optional() }).optional(),
      marketingPixels: z.unknown().optional(),
      chatConfig: z.unknown().optional(),
      homePageConfig: z
        .object({
          sections: z
            .array(
              z.object({
                id: z.string().min(1),
                title: z.string().optional(),
                categoryIds: z.array(z.string()).min(1),
                mode: z.enum(["carousel", "grid", "responsive"]),
                auto: z.boolean(),
                seconds: z.number().int().min(1).max(60),
                perView: z.object({ mobile: z.number().int().min(1).max(4), tablet: z.number().int().min(1).max(6), desktop: z.number().int().min(1).max(8) }),
                pagination: z.boolean(),
                loop: z.boolean(),
                showViewAll: z.boolean(),
              })
            )
            .optional(),
        })
        .optional(),
      heroBannerConfig: z
        .object({
          enabled: z.boolean().optional(),
          image: z.string().nullable().optional(),
          badge: z.string().nullable().optional(),
          title: z.string().nullable().optional(),
          accent: z.string().nullable().optional(),
          subtitle: z.string().nullable().optional(),
          buttonLabel: z.string().nullable().optional(),
          buttonLink: z.string().nullable().optional(),
          secondaryLabel: z.string().nullable().optional(),
          secondaryLink: z.string().nullable().optional(),
          announceText: z.string().nullable().optional(),
        })
        .optional(),
      navigationConfig: z
        .object({
          menus: z
            .array(
              z.object({
                id: z.string().min(1),
                label: z.string().min(1),
                location: z.string().min(1),
                items: z.array(z.any()),
              })
            )
            .default([]),
        })
        .optional(),
      enableIpLimit: z.boolean().optional(),
      cooldownMinutes: z.number().int().min(1).max(1440).optional(),
      paymentConfig: paymentSettingsSchema.optional(),
      emailConfig: z.object({ host: z.string(), port: z.number().int(), user: z.string(), pass: z.string(), fromEmail: z.string().email() }).optional(),
      courierConfig: z
        .object({
          steadfast: z.object({ enabled: z.boolean(), apiKey: z.string().optional(), secretKey: z.string().optional() }).optional(),
          pathao: z.object({ enabled: z.boolean(), clientId: z.string().optional(), clientSecret: z.string().optional(), clientEmail: z.string().optional() }).optional(),
          redx: z.object({ enabled: z.boolean(), apiKey: z.string().optional() }).optional(),
        })
        .optional(),
      storageConfig: z
        .discriminatedUnion("provider", [
          z.object({
            provider: z.literal("hostinger-object-storage"),
            endpoint: z.string().url().optional(),
            region: z.string().optional(),
            bucket: z.string().min(1).optional(),
            accessKeyId: z.string().min(1).optional(),
            secretAccessKey: z.string().min(1).optional(),
            publicBaseUrl: z.string().url().optional(),
          }),
          z.object({ provider: z.literal("local"), folderPath: z.string().min(1), publicBaseUrl: z.string().min(1) }),
        ])
        .optional(),
      aiConfig: z.object({ provider: z.enum(["openai", "gemini"]), apiKey: z.string(), systemPromptOverride: z.string().optional() }).optional(),
    })
    .safeParse(req.body);

  if (!data.success) return res.status(400).json({ error: "Invalid store configuration" });
  const input = data.data;
  const existing = await prisma.storeConfig.findUnique({
    where: { id: "store-config-singleton" },
    select: { featureFlags: true, paymentConfig: true, emailConfig: true, courierConfig: true, storageConfig: true, aiConfig: true },
  });
  const priorPayment = decrypt<PaymentSettings>((existing?.paymentConfig as { encrypted?: string } | null)?.encrypted) ?? {};
  const mergeGateway = <T extends Record<string, unknown>>(oldValue: T | undefined, newValue: T | undefined) =>
    newValue ? { ...oldValue, ...newValue, ...Object.fromEntries(Object.entries(newValue).filter(([, value]) => value !== undefined && value !== "")) } : oldValue;

  const paymentConfig = input.paymentConfig
    ? {
        bkash: mergeGateway(priorPayment.bkash, input.paymentConfig.bkash),
        nagad: mergeGateway(priorPayment.nagad, input.paymentConfig.nagad),
        sslcommerz: mergeGateway(priorPayment.sslcommerz, input.paymentConfig.sslcommerz),
      }
    : undefined;

  const priorStorage = decrypt<Record<string, unknown>>((existing?.storageConfig as { encrypted?: string } | null)?.encrypted) ?? {};
  const storageConfig = input.storageConfig
    ? ({ ...priorStorage, ...input.storageConfig, ...Object.fromEntries(Object.entries(input.storageConfig).filter(([, value]) => value !== undefined && value !== "")) } as Record<
        string,
        unknown
      >)
    : undefined;

  const config = await prisma.storeConfig.update({
    where: { id: "store-config-singleton" },
    data: {
      ...input,
      themeSettings: input.themeSettings as Prisma.InputJsonValue,
      featureFlags: input.featureFlags ? ({ ...defaultFeatureFlags, ...((existing?.featureFlags as object | null) ?? {}), ...input.featureFlags } as Prisma.InputJsonValue) : undefined,
      marketingPixels: input.marketingPixels as Prisma.InputJsonValue,
      chatConfig: input.chatConfig as Prisma.InputJsonValue,
      homePageConfig: input.homePageConfig as Prisma.InputJsonValue,
      heroBannerConfig: input.heroBannerConfig as Prisma.InputJsonValue,
      navigationConfig: input.navigationConfig as Prisma.InputJsonValue,
      paymentConfig: paymentConfig ? { encrypted: encrypt(paymentConfig) } : undefined,
      emailConfig: input.emailConfig ? { encrypted: encrypt(input.emailConfig) } : undefined,
      courierConfig: input.courierConfig ? { encrypted: encrypt(input.courierConfig) } : undefined,
      storageConfig: storageConfig ? { encrypted: encrypt(storageConfig) } : undefined,
      aiConfig: input.aiConfig ? { encrypted: encrypt(input.aiConfig) } : undefined,
    },
  });

  const updatedStorage = config.storageConfig as { encrypted?: string } | null;
  const updatedPayment = config.paymentConfig as { encrypted?: string } | null;
  const updatedEmail = config.emailConfig as { encrypted?: string } | null;
  const updatedCourier = config.courierConfig as { encrypted?: string } | null;
  const updatedAi = config.aiConfig as { encrypted?: string } | null;
  const dec = (v: { encrypted?: string } | null) => (v?.encrypted ? (decrypt<Record<string, unknown>>(v.encrypted) ?? null) : null);
  res.json({
    ...config,
    featureFlags: { ...defaultFeatureFlags, ...((config.featureFlags as Record<string, boolean> | null) ?? {}) },
    paymentConfig: dec(updatedPayment),
    emailConfig: dec(updatedEmail),
    courierConfig: dec(updatedCourier),
    storageConfig: dec(updatedStorage),
    aiConfig: dec(updatedAi),
  });
});

app.get("/api/admin/config", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const config = await prisma.storeConfig.findUnique({ where: { id: "store-config-singleton" } });
  if (!config) return res.status(404).json({ error: "Store is not configured" });
  const encrypted = config.paymentConfig as { encrypted?: string } | null;
  const payments = encrypted?.encrypted ? (decrypt<PaymentSettings>(encrypted.encrypted) ?? {}) : {};
  const storage = config.storageConfig as { encrypted?: string } | null;
  const storageDecrypted = storage?.encrypted ? (decrypt<Record<string, unknown>>(storage.encrypted) ?? null) : null;
  const email = config.emailConfig as { encrypted?: string } | null;
  const emailDecrypted = email?.encrypted ? (decrypt<Record<string, unknown>>(email.encrypted) ?? null) : null;
  const courier = config.courierConfig as { encrypted?: string } | null;
  const courierDecrypted = courier?.encrypted ? (decrypt<Record<string, unknown>>(courier.encrypted) ?? null) : null;
  const ai = config.aiConfig as { encrypted?: string } | null;
  const aiDecrypted = ai?.encrypted ? (decrypt<Record<string, unknown>>(ai.encrypted) ?? null) : null;
  res.json({
    ...config,
    featureFlags: { ...defaultFeatureFlags, ...((config.featureFlags as Record<string, boolean> | null) ?? {}) },
    paymentConfig: payments,
    emailConfig: emailDecrypted,
    courierConfig: courierDecrypted,
    storageConfig: storageDecrypted,
    aiConfig: aiDecrypted,
    emailConfigured: Boolean(config.emailConfig),
    courierConfigured: Boolean(config.courierConfig),
    storageConfigured: Boolean(config.storageConfig),
    aiConfigured: Boolean(config.aiConfig),
  });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(Number(process.env.PORT ?? 4000), () => console.log(`API listening on ${process.env.PORT ?? 4000}`));
