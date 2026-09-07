import { prisma } from "./lib/prisma.js";
import bcrypt from "bcryptjs";

const EMAIL = "test.admin@tmp.local";
const PASSWORD = "TempPass#123";

async function main() {
  const args = process.argv.slice(2);
  const remove = args.includes("--delete") || args.includes("-d");

  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });

  if (remove) {
    if (existing) {
      await prisma.session.deleteMany({ where: { userId: existing.id } });
      await prisma.user.delete({ where: { id: existing.id } });
      console.log(`Deleted ${EMAIL}`);
    } else {
      console.log(`No test admin found (${EMAIL})`);
    }
    await prisma.$disconnect();
    return;
  }

  if (existing) {
    console.log(`Test admin already exists: ${EMAIL} / ${PASSWORD}`);
    console.log("Pass --delete to remove it.");
    await prisma.$disconnect();
    return;
  }

  const user = await prisma.user.create({
    data: { name: "Test Admin", email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 12), role: "ADMIN" },
  });
  console.log(`Created test admin: ${user.id}`);
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  role:     ${user.role}`);
  await prisma.$disconnect();
}

main();