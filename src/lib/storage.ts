import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { prisma } from "./prisma.js";
import { decrypt } from "./crypto.js";

export type StorageConfig =
  | { provider: "local"; folderPath: string; publicBaseUrl: string }
  | { provider: "hostinger-object-storage"; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl?: string };

const has = (value: unknown, key: string): boolean => Boolean(value && typeof value === "object" && key in (value as Record<string, unknown>));

export function isLocalConfig(value: unknown): value is Extract<StorageConfig, { provider: "local" }> {
  return has(value, "provider") && (value as { provider: string }).provider === "local" && typeof (value as Extract<StorageConfig, { provider: "local" }>).folderPath === "string" && typeof (value as Extract<StorageConfig, { provider: "local" }>).publicBaseUrl === "string";
}

export function isHostingerConfig(value: unknown): value is Extract<StorageConfig, { provider: "hostinger-object-storage" }> {
  return has(value, "provider") && (value as { provider: string }).provider === "hostinger-object-storage" && ["endpoint", "bucket", "accessKeyId", "secretAccessKey"].every(key => typeof (value as Record<string, unknown>)[key] === "string");
}

export async function loadStorageConfig(): Promise<StorageConfig | null> {
  const config = await prisma.storeConfig.findUnique({ where: { id: "store-config-singleton" }, select: { storageConfig: true } });
  const stored = config?.storageConfig as { encrypted?: string } | null;
  const parsed = stored?.encrypted ? decrypt<unknown>(stored.encrypted) : undefined;
  if (isLocalConfig(parsed) || isHostingerConfig(parsed)) return parsed;
  return null;
}

export async function uploadImage(file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<string> {
  const storageConfig = await loadStorageConfig();
  if (!storageConfig) throw new Error("Storage is not configured. Add it from the Storage settings, then retry.");

  const ext = (extname(file.originalname) || ".img").toLowerCase();

  if (storageConfig.provider === "local") {
    const productsDir = join(process.cwd(), "public", "uploads", "products");
    mkdirSync(productsDir, { recursive: true });
    const hash = createHash("sha256").update(file.buffer).digest("hex");
    const existing = readdirSync(productsDir).find((name) => name.startsWith(hash));
    if (existing) return `/uploads/products/${existing}`;
    const filename = `${hash}${ext}`;
    writeFileSync(join(productsDir, filename), file.buffer);
    return `/uploads/products/${filename}`;
  }

  const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const hash = createHash("sha256").update(file.buffer).digest("hex").slice(0, 12);
  const filename = `${hash}${ext}`;
  const key = `uploads/products/${filename}`;
  const client = new S3Client({ region: storageConfig.region, endpoint: storageConfig.endpoint, forcePathStyle: true, credentials: { accessKeyId: storageConfig.accessKeyId, secretAccessKey: storageConfig.secretAccessKey } });
  await client.send(new PutObjectCommand({ Bucket: storageConfig.bucket, Key: key, Body: file.buffer, ContentType: file.mimetype, ACL: "public-read" }));
  const base = storageConfig.publicBaseUrl?.replace(/[\\/]+$/, "") ?? `${storageConfig.endpoint.replace(/[\\/]+$/, "")}/${storageConfig.bucket}`;
  return `${base}/${key}`;
}

export async function deleteImage(url: string): Promise<void> {
  const storageConfig = await loadStorageConfig();
  if (!storageConfig) return;
  const pathname = new URL(url, "http://localhost").pathname;
  const match = /^\/uploads\/products\/([^/]+)$/.exec(pathname);
  if (!match) return;
  if (storageConfig.provider === "local") {
    const file = join(process.cwd(), "public", match[0]);
    try {
      unlinkSync(file);
    } catch {
      // file already gone or not deletable — treat as success
    }
    return;
  }
  const { DeleteObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: storageConfig.region, endpoint: storageConfig.endpoint, forcePathStyle: true, credentials: { accessKeyId: storageConfig.accessKeyId, secretAccessKey: storageConfig.secretAccessKey } });
  await client.send(new DeleteObjectCommand({ Bucket: storageConfig.bucket, Key: pathname.slice(1) }));
}
