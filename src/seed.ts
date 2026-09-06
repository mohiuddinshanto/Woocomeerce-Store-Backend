import { prisma } from "./lib/prisma.js";

const catalog = [
  { category: "Fashion", categorySlug: "fashion", name: "Signature Linen Shirt", slug: "signature-linen-shirt", description: "Breathable premium linen with a relaxed, considered fit for every day.", price: 1890, salePrice: 1590, stock: 18, image: "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=1000&q=85" },
  { category: "Fashion", categorySlug: "fashion", name: "Essential Canvas Tote", slug: "essential-canvas-tote", description: "A sturdy, minimal canvas tote made for daily errands and weekend plans.", price: 890, stock: 26, image: "https://images.unsplash.com/photo-1594223274512-ad4803739b7c?auto=format&fit=crop&w=1000&q=85" },
  { category: "Footwear", categorySlug: "footwear", name: "Cloud Everyday Sneakers", slug: "cloud-everyday-sneakers", description: "Comfort-focused sneakers with a clean profile and cushioned sole.", price: 2490, salePrice: 2190, stock: 14, image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1000&q=85" },
  { category: "Home", categorySlug: "home", name: "Hand-poured Soy Candle", slug: "hand-poured-soy-candle", description: "A calm, warm scent in a reusable amber glass vessel.", price: 690, stock: 32, image: "https://images.unsplash.com/photo-1602874801006-e26b71c09cfd?auto=format&fit=crop&w=1000&q=85" },
  { category: "Home", categorySlug: "home", name: "Stoneware Morning Mug", slug: "stoneware-morning-mug", description: "Hand-finished stoneware with an easy, comfortable handle.", price: 790, stock: 20, image: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?auto=format&fit=crop&w=1000&q=85" },
  { category: "Lifestyle", categorySlug: "lifestyle", name: "Daily Notes Journal", slug: "daily-notes-journal", description: "A linen-bound journal with smooth pages for plans, lists and ideas.", price: 490, stock: 40, image: "https://images.unsplash.com/photo-1531346680769-a1d79b57de5c?auto=format&fit=crop&w=1000&q=85" }
];

async function main() {
  for (const item of catalog) {
    const category = await prisma.category.upsert({ where: { slug: item.categorySlug }, update: { name: item.category }, create: { name: item.category, slug: item.categorySlug } });
    await prisma.product.upsert({ where: { slug: item.slug }, update: { name: item.name, description: item.description, price: item.price, salePrice: item.salePrice, stock: item.stock, images: [item.image], categoryId: category.id, isActive: true }, create: { name: item.name, slug: item.slug, description: item.description, price: item.price, salePrice: item.salePrice, stock: item.stock, images: [item.image], categoryId: category.id } });
  }
  console.log(`Seeded ${catalog.length} products.`);
}

main().finally(() => prisma.$disconnect());
