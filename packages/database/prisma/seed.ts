import 'dotenv/config';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import * as argon2 from 'argon2';
import { createPrismaClient } from '../src/index';

config({ path: resolve(__dirname, '../../../.env') });

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run development seed in production (NODE_ENV=production)');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for seed');
}

const resetPasswords = process.env.SEED_RESET_PASSWORDS === 'true';

const prisma = createPrismaClient(databaseUrl);

const DEV_USERS = [
  {
    login: 'director',
    email: 'director@flower.local',
    name: 'Директор',
    role: 'DIRECTOR' as const,
    password: 'Director123!',
  },
  {
    login: 'manager',
    email: 'manager@flower.local',
    name: 'Менеджер',
    role: 'MANAGER' as const,
    password: 'Manager123!',
  },
  {
    login: 'florist',
    email: 'florist@flower.local',
    name: 'Флорист',
    role: 'FLORIST' as const,
    password: 'Florist123!',
  },
];

const DEV_PRODUCTS = [
  {
    name: 'Роза Red Naomi',
    sku: 'ROSE-RN',
    type: 'FLOWER' as const,
    unit: 'PIECE' as const,
    salePrice: '5.00',
  },
  {
    name: 'Эустома белая',
    sku: 'EUS-W',
    type: 'FLOWER' as const,
    unit: 'PIECE' as const,
    salePrice: '4.00',
  },
  {
    name: 'Гипсофила',
    sku: 'GYP-1',
    type: 'FLOWER' as const,
    unit: 'PIECE' as const,
    salePrice: '2.50',
  },
  {
    name: 'Упаковка букета',
    sku: 'SRV-WRAP',
    type: 'SERVICE' as const,
    unit: 'PIECE' as const,
    purchasePrice: '0.50',
    salePrice: '3.00',
  },
];

async function main(): Promise<void> {
  for (const user of DEV_USERS) {
    const passwordHash = await argon2.hash(user.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const existing = await prisma.user.findUnique({ where: { login: user.login } });
    if (existing) {
      await prisma.user.update({
        where: { login: user.login },
        data: {
          name: user.name,
          email: user.email,
          role: user.role,
          isActive: true,
          ...(resetPasswords ? { passwordHash } : {}),
        },
      });
    } else {
      await prisma.user.create({
        data: {
          login: user.login,
          email: user.email,
          name: user.name,
          role: user.role,
          passwordHash,
          isActive: true,
        },
      });
    }
  }

  for (const product of DEV_PRODUCTS) {
    const existing = await prisma.product.findFirst({
      where: {
        OR: [{ sku: product.sku }, { name: product.name }],
      },
    });

    if (existing) {
      // Keep FLOWER purchasePrice cleared (batch-costed).
      if (existing.type === 'FLOWER' && existing.purchasePrice != null) {
        await prisma.product.update({
          where: { id: existing.id },
          data: { purchasePrice: null },
        });
      }
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: product.name,
          sku: product.sku,
          type: product.type,
          unit: product.unit,
          purchasePrice: product.type === 'SERVICE' ? (product.purchasePrice ?? null) : null,
          salePrice: product.salePrice,
          isActive: true,
        },
      });

      if (product.type === 'FLOWER') {
        await tx.productStock.create({
          data: {
            productId: created.id,
            quantityOnHand: 0,
            quantityReserved: 0,
          },
        });
      }
    });
  }

  console.log('Seeded development users: director, manager, florist');
  console.log('Seeded development products: 3 FLOWER + 1 SERVICE (stock starts at 0, no supplies)');

  // Demo bouquet recipe (no stock mutation).
  const rose = await prisma.product.findFirst({ where: { sku: 'ROSE-RN' } });
  const eustoma = await prisma.product.findFirst({ where: { sku: 'EUS-W' } });
  const wrap = await prisma.product.findFirst({ where: { sku: 'SRV-WRAP' } });
  if (rose && eustoma && wrap) {
    const existingBouquet = await prisma.bouquet.findFirst({
      where: { name: 'Нежность' },
      include: { items: true },
    });
    if (!existingBouquet) {
      await prisma.bouquet.create({
        data: {
          name: 'Нежность',
          description: 'Демонстрационный состав для разработки',
          salePrice: '85.00',
          isActive: true,
          version: 1,
          items: {
            create: [
              { productId: rose.id, quantity: 7 },
              { productId: eustoma.id, quantity: 3 },
              { productId: wrap.id, quantity: 1 },
            ],
          },
        },
      });
      console.log('Seeded demo bouquet: Нежность');
    }
  }

  if (resetPasswords) {
    console.log('SEED_RESET_PASSWORDS=true — passwords were reset to development defaults.');
  } else {
    console.log('Existing users kept their passwords (set SEED_RESET_PASSWORDS=true to reset).');
  }
  console.log('Development credentials only — never use in production.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
