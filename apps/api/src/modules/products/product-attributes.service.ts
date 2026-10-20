import { Injectable } from '@nestjs/common';
import { ProductAttrKind, type ProductAttributeValueDto } from '@erp/shared';
import { PrismaService } from '../prisma/prisma.service';
import { parentKeyFor } from './product-attr.util';

@Injectable()
export class ProductAttributesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    kind: ProductAttrKind;
    parentId?: string | null;
    search?: string;
    limit?: number;
  }): Promise<ProductAttributeValueDto[]> {
    const parentKey = attrRequiresListParent(params.kind)
      ? parentKeyFor(params.parentId ?? null)
      : '';

    const where: {
      kind: ProductAttrKind;
      parentKey?: string;
      name?: { contains: string; mode: 'insensitive' };
    } = { kind: params.kind };

    if (attrRequiresListParent(params.kind)) {
      where.parentKey = parentKey;
    }

    if (params.search?.trim()) {
      where.name = { contains: params.search.trim(), mode: 'insensitive' };
    }

    const rows = await this.prisma.productAttributeValue.findMany({
      where,
      orderBy: { name: 'asc' },
      take: Math.min(params.limit ?? 100, 200),
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as ProductAttrKind,
      name: row.name,
      parentId: row.parentId,
      parentKey: row.parentKey,
    }));
  }
}

function attrRequiresListParent(kind: ProductAttrKind): boolean {
  return kind === ProductAttrKind.VARIETY || kind === ProductAttrKind.FLOWER_FORM;
}
