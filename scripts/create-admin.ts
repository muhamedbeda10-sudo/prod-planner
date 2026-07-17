/**
 * Create (or repair) an admin account. Usage:
 *   npx tsx scripts/create-admin.ts <email> <name> [password]
 * If password is omitted a random one is generated and printed ONCE.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

async function main() {
  const [email, name, passwordArg] = process.argv.slice(2);
  if (!email || !name) {
    console.error("Usage: npx tsx scripts/create-admin.ts <email> <name> [password]");
    process.exit(1);
  }
  const password = passwordArg || randomBytes(9).toString("base64url");
  const data = { name, passwordHash: hashPassword(password), isAdmin: true, active: true };
  await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    create: { email: email.toLowerCase(), ...data },
    update: data,
  });
  console.log(`Admin ready: ${email}`);
  console.log(`Password:    ${password}`);
}

main().finally(() => prisma.$disconnect());
