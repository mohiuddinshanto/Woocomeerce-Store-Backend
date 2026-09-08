import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export type AttributeValueInput = {
  id: string;
  value: string;
  colorSwatch?: string | null;
  image?: string | null;
};

export type AttributeInput = {
  id: string;
  name: string;
  values: AttributeValueInput[];
};

export type VariationAttributeInput = {
  attributeId: string;
  valueId: string;
};

export type VariationInput = {
  id: string;
  name: string;
  sku?: string | null;
  price: number;
  salePrice?: number | null;
  stock: number;
  manageStock?: boolean;
  weight?: number | null;
  image?: string | null;
  gallery?: string[];
  description?: string | null;
  status?: string;
  isDefault?: boolean;
  attributes: VariationAttributeInput[];
};

export type VariationCombination = {
  name: string;
  parts: string[];
  attributeValueIds: Record<string, string>;
};

const sanitizeSkuPart = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export function generateVariationCombinations(attributes: { id: string; name: string; values: { id: string; value: string }[] }[]): VariationCombination[] {
  const attrs = attributes.filter((a) => a.name.trim() && a.values.some((v) => v.value.trim()));
  if (!attrs.length) return [];
  let combos: VariationCombination[] = [{ name: "", parts: [], attributeValueIds: {} }];
  for (const attr of attrs) {
    const next: VariationCombination[] = [];
    for (const combo of combos) {
      for (const val of attr.values) {
        if (!val.value.trim()) continue;
        next.push({
          name: combo.name ? `${combo.name} / ${val.value.trim()}` : val.value.trim(),
          parts: [...combo.parts, val.value.trim()],
          attributeValueIds: { ...combo.attributeValueIds, [attr.id]: val.id },
        });
      }
    }
    combos = next;
  }
  return combos;
}

export async function makeUniqueSku(candidate: string, excludeIds: string[] = []): Promise<string> {
  const base = candidate || `VAR-${Date.now().toString().slice(-6)}`;
  let sku = base;
  let i = 1;
  for (;;) {
    const existing = await prisma.productVariation.findFirst({ where: { sku, id: { notIn: excludeIds } }, select: { id: true } });
    if (!existing) return sku;
    sku = `${base}-${i++}`;
  }
}

export function baseSkuForParts(prefix: string | undefined, parts: string[]): string {
  const prefixPart = prefix ? sanitizeSkuPart(prefix) : "";
  const partsPart = parts.map(sanitizeSkuPart).join("-");
  if (prefixPart && partsPart) return `${prefixPart}-${partsPart}`;
  return prefixPart || partsPart;
}

export async function generateVariationsForProduct(
  productId: string,
  attributes: { id: string; name: string; values: { id: string; value: string }[] }[],
  opts: { basePrice?: number; baseStock?: number; skuPrefix?: string } = {}
): Promise<{ created: number }> {
  const combos = generateVariationCombinations(attributes);
  if (!combos.length) return { created: 0 };

  const prefix = opts.skuPrefix;
  const skus: string[] = [];
  for (const combo of combos) {
    const base = baseSkuForParts(prefix, combo.parts);
    skus.push(await makeUniqueSku(base || "VAR"));
  }

  let created = 0;
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];
      const sku = skus[i];
      await tx.productVariation.create({
        data: {
          productId,
          name: combo.name,
          sku,
          price: opts.basePrice ?? 0,
          stock: Math.max(0, Math.floor(opts.baseStock ?? 0)),
          manageStock: true,
          status: "active",
          attributes: {
            create: Object.entries(combo.attributeValueIds).map(([attributeId, valueId]) => ({ attributeId, valueId })),
          },
        },
      });
      created++;
    }
  });
  return { created };
}

/**
 * Replaces (in a transaction) a product's attributes and variations.
 * Caller-supplied ids (temp ids from the admin form) are mapped to real DB ids.
 */
export async function replaceProductVariations(
  productId: string,
  attributes: AttributeInput[],
  variations: VariationInput[],
  baseSkuPrefix?: string
): Promise<void> {
  const cleanAttributes = attributes
    .map((a) => ({
      id: a.id,
      name: a.name.trim(),
      values: a.values.filter((v) => v.value.trim()).map((v) => ({ ...v, value: v.value.trim() })),
    }))
    .filter((a) => a.name && a.values.length > 0);

  const cleanVariations = variations
    .map((v) => ({ ...v, name: v.name.trim() }))
    .filter((v) => v.name && v.attributes.length > 0);

  await prisma.$transaction(async (tx) => {
    await tx.productVariation.deleteMany({ where: { productId } });
    await tx.productAttribute.deleteMany({ where: { productId } });

    const attrIdMap = new Map<string, string>();
    const valueIdMap = new Map<string, string>();

    for (const attr of cleanAttributes) {
      const createdAttr = await tx.productAttribute.create({ data: { productId, name: attr.name } });
      attrIdMap.set(attr.id, createdAttr.id);
      for (const val of attr.values) {
        const createdVal = await tx.attributeValue.create({
          data: { attributeId: createdAttr.id, value: val.value, colorSwatch: val.colorSwatch || null, image: val.image || null },
        });
        valueIdMap.set(val.id, createdVal.id);
      }
    }

    let defaultVariationRealId: string | undefined;
    for (const v of cleanVariations) {
      const resolved = v.attributes
        .filter((a) => attrIdMap.has(a.attributeId) && valueIdMap.has(a.valueId))
        .map((a) => ({ attributeId: attrIdMap.get(a.attributeId)!, valueId: valueIdMap.get(a.valueId)! }));

      const partsForSku = cleanAttributes.map((attr) => {
        const pair = resolved.find((r) => r.attributeId === attrIdMap.get(attr.id));
        if (!pair) return "";
        const matched = attr.values.find((val) => valueIdMap.get(val.id) === pair.valueId);
        return matched?.value ?? "";
      });

      let sku = v.sku && v.sku.trim() ? v.sku.trim().toUpperCase() : baseSkuForParts(baseSkuPrefix, partsForSku.filter(Boolean));
      sku = await makeUniqueSku(sku || "VAR");

      const created = await tx.productVariation.create({
        data: {
          productId,
          name: v.name,
          sku,
          price: v.price,
          salePrice: v.salePrice ?? null,
          stock: Math.max(0, Math.floor(v.stock || 0)),
          manageStock: v.manageStock !== false,
          weight: v.weight ?? null,
          image: v.image || null,
          gallery: v.gallery && v.gallery.length ? (v.gallery as Prisma.InputJsonValue) : Prisma.JsonNull,
          description: v.description || null,
          status: v.status === "disabled" ? "disabled" : "active",
        },
      });
      if (resolved.length) {
        await tx.variationAttribute.createMany({ data: resolved.map((r) => ({ variationId: created.id, attributeId: r.attributeId, valueId: r.valueId })) });
      }
      if (v.isDefault) defaultVariationRealId = created.id;
    }

    await tx.product.update({
      where: { id: productId },
      data: { defaultVariationId: defaultVariationRealId ?? null },
    });
  });
}