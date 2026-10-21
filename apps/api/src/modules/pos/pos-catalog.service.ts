import { Injectable } from '@nestjs/common';
import { AssembledBouquetStatus, ProductType, type PosCatalogItemDto } from '@erp/shared';
import type { Prisma } from '@erp/database';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToMoneyString } from '../products/product-mapper';

const SEARCH_LIMIT = 40;
const POPULAR_BOUQUETS = 10;
const POPULAR_FLOWERS = 10;
const POPULAR_SERVICES = 8;
const POPULAR_ASSEMBLED = 8;

type ProductRow = {
  id: string;
  name: string;
  type: string;
  salePrice: Prisma.Decimal | null;
  primaryImageId: string | null;
  stock: { quantityOnHand: number; quantityReserved: number } | null;
};

const productSelect = {
  id: true,
  name: true,
  type: true,
  salePrice: true,
  primaryImageId: true,
  stock: { select: { quantityOnHand: true, quantityReserved: true } },
} as const;

@Injectable()
export class PosCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active FLOWER + SERVICE products, active bouquet templates, display assembled bouquets. */
  async search(q: string | undefined): Promise<PosCatalogItemDto[]> {
    const term = q?.trim() ?? '';
    if (!term) return [];

    const [products, bouquets, assembled] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          isActive: true,
          type: { in: [ProductType.FLOWER, ProductType.SERVICE] },
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { sku: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: productSelect,
        orderBy: { name: 'asc' },
        take: SEARCH_LIMIT,
      }),
      this.prisma.bouquet.findMany({
        where: { isActive: true, name: { contains: term, mode: 'insensitive' } },
        select: { id: true, name: true, salePrice: true },
        orderBy: { name: 'asc' },
        take: SEARCH_LIMIT,
      }),
      this.prisma.assembledBouquet.findMany({
        where: {
          orderId: null,
          status: AssembledBouquetStatus.ASSEMBLED,
          OR: [
            { nameSnapshot: { contains: term, mode: 'insensitive' } },
            { number: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          number: true,
          status: true,
          nameSnapshot: true,
          bouquetTemplate: { select: { salePrice: true } },
        },
        orderBy: { assembledAt: 'desc' },
        take: SEARCH_LIMIT,
      }),
    ]);

    const items: PosCatalogItemDto[] = [
      ...assembled.map<PosCatalogItemDto>((a) => ({
        kind: 'ASSEMBLED',
        id: a.id,
        name: a.nameSnapshot,
        salePrice: decimalToMoneyString(a.bouquetTemplate?.salePrice),
        productType: null,
        availableQuantity: null,
        assembledNumber: a.number,
        assembledStatus: a.status as AssembledBouquetStatus,
        primaryImageId: null,
      })),
      ...bouquets.map<PosCatalogItemDto>((b) => ({
        kind: 'BOUQUET',
        id: b.id,
        name: b.name,
        salePrice: decimalToMoneyString(b.salePrice),
        productType: null,
        availableQuantity: null,
        assembledNumber: null,
        assembledStatus: null,
        primaryImageId: null,
      })),
      ...products.map((p) => this.productItem(p)),
    ];
    return items.slice(0, SEARCH_LIMIT);
  }

  /** Quick-pick: recent templates, flowers, services, and display (vitrine) bouquets. */
  async popular(): Promise<PosCatalogItemDto[]> {
    const [bouquets, flowers, services, assembled] = await Promise.all([
      this.prisma.bouquet.findMany({
        where: { isActive: true },
        select: { id: true, name: true, salePrice: true },
        orderBy: { updatedAt: 'desc' },
        take: POPULAR_BOUQUETS,
      }),
      this.prisma.product.findMany({
        where: { isActive: true, type: ProductType.FLOWER },
        select: productSelect,
        orderBy: { name: 'asc' },
        take: POPULAR_FLOWERS,
      }),
      this.prisma.product.findMany({
        where: { isActive: true, type: ProductType.SERVICE },
        select: productSelect,
        orderBy: { name: 'asc' },
        take: POPULAR_SERVICES,
      }),
      this.prisma.assembledBouquet.findMany({
        where: { orderId: null, status: AssembledBouquetStatus.ASSEMBLED },
        select: {
          id: true,
          number: true,
          status: true,
          nameSnapshot: true,
          bouquetTemplate: { select: { salePrice: true } },
        },
        orderBy: { assembledAt: 'desc' },
        take: POPULAR_ASSEMBLED,
      }),
    ]);
    return [
      ...assembled.map<PosCatalogItemDto>((a) => ({
        kind: 'ASSEMBLED',
        id: a.id,
        name: a.nameSnapshot,
        salePrice: decimalToMoneyString(a.bouquetTemplate?.salePrice),
        productType: null,
        availableQuantity: null,
        assembledNumber: a.number,
        assembledStatus: a.status as AssembledBouquetStatus,
        primaryImageId: null,
      })),
      ...bouquets.map<PosCatalogItemDto>((b) => ({
        kind: 'BOUQUET',
        id: b.id,
        name: b.name,
        salePrice: decimalToMoneyString(b.salePrice),
        productType: null,
        availableQuantity: null,
        assembledNumber: null,
        assembledStatus: null,
        primaryImageId: null,
      })),
      ...flowers.map((p) => this.productItem(p)),
      ...services.map((p) => this.productItem(p)),
    ];
  }

  private productItem(p: ProductRow): PosCatalogItemDto {
    const isFlower = p.type === ProductType.FLOWER;
    return {
      kind: isFlower ? 'PRODUCT' : 'SERVICE',
      id: p.id,
      name: p.name,
      salePrice: decimalToMoneyString(p.salePrice),
      productType: p.type as ProductType,
      availableQuantity: isFlower
        ? (p.stock?.quantityOnHand ?? 0) - (p.stock?.quantityReserved ?? 0)
        : null,
      assembledNumber: null,
      assembledStatus: null,
      primaryImageId: p.primaryImageId,
    };
  }
}
