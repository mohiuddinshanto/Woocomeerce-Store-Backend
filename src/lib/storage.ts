import { mkdirSync, writeFileSync } from "node:fs";
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
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const key = `products/${filename}`;

  if (storageConfig.provider === "local") {
    const folder = storageConfig.folderPath.replace(/[\\/]+$/, "");
    const absoluteFolder = join(process.cwd(), folder);
    mkdirSync(absoluteFolder, { recursive: true });
    writeFileSync(join(absoluteFolder, filename), file.buffer);
    const base = storageConfig.publicBaseUrl.replace(/[\\/]+$/, "");
    return `${base}/${filename}`;
  }

  const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: storageConfig.region, endpoint: storageConfig.endpoint, forcePathStyle: true, credentials: { accessKeyId: storageConfig.accessKeyId, secretAccessKey: storageConfig.secretAccessKey } });
  await client.send(new PutObjectCommand({ Bucket: storageConfig.bucket, Key: key, Body: file.buffer, ContentType: file.mimetype, ACL: "public-read" }));
  const base = storageConfig.publicBaseUrl?.replace(/[\\/]+$/, "") ?? `${storageConfig.endpoint.replace(/[\\/]+$/, "")}/${storageConfig.bucket}`;
  return `${base}/${key}`;
}
