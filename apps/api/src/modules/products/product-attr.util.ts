import { ProductAttrKind, normalizeProductAttrName } from '@erp/shared';
import { Prisma } from '@erp/database';
import { HttpStatus } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';

export type AttrRef = { id?: string | null; name?: string | null };

export function displayNameFromRaw(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function parentKeyFor(parentId: string | null | undefined): string {
  return parentId && parentId.length > 0 ? parentId : '';
}

/** Kinds that are scoped under flower kind (parentKey = kind id). */
export function attrRequiresParent(kind: ProductAttrKind): boolean {
  return kind === ProductAttrKind.VARIETY || kind === ProductAttrKind.FLOWER_FORM;
}

export async function createOrGetAttributeValue(
  tx: Prisma.TransactionClient,
  kind: ProductAttrKind,
  rawName: string,
  parentId: string | null,
): Promise<{
  id: string;
  name: string;
  kind: ProductAttrKind;
  parentId: string | null;
  parentKey: string;
}> {
  const name = displayNameFromRaw(rawName);
  if (name.length < 1 || name.length > 100) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Название характеристики должно быть от 1 до 100 символов',
      {},
      HttpStatus.BAD_REQUEST,
    );
  }

  if (attrRequiresParent(kind) && !parentId) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Сначала выберите вид цветка',
      { kind },
      HttpStatus.BAD_REQUEST,
    );
  }

  if (parentId) {
    const parent = await tx.productAttributeValue.findUnique({ where: { id: parentId } });
    if (!parent || parent.kind !== ProductAttrKind.FLOWER_KIND) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Некорректный родительский вид цветка',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  const normalizedName = normalizeProductAttrName(name);
  const parentKey = parentKeyFor(parentId);

  const existing = await tx.productAttributeValue.findUnique({
    where: {
      kind_parentKey_normalizedName: { kind, parentKey, normalizedName },
    },
  });
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      kind: existing.kind as ProductAttrKind,
      parentId: existing.parentId,
      parentKey: existing.parentKey,
    };
  }

  try {
    const created = await tx.productAttributeValue.create({
      data: {
        kind,
        name,
        normalizedName,
        parentKey,
        parentId: parentId ?? null,
      },
    });
    return {
      id: created.id,
      name: created.name,
      kind: created.kind as ProductAttrKind,
      parentId: created.parentId,
      parentKey: created.parentKey,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await tx.productAttributeValue.findUnique({
        where: {
          kind_parentKey_normalizedName: { kind, parentKey, normalizedName },
        },
      });
      if (raced) {
        return {
          id: raced.id,
          name: raced.name,
          kind: raced.kind as ProductAttrKind,
          parentId: raced.parentId,
          parentKey: raced.parentKey,
        };
      }
    }
    throw error;
  }
}

export async function resolveAttrRef(
  tx: Prisma.TransactionClient,
  kind: ProductAttrKind,
  ref: AttrRef | null | undefined,
  parentId: string | null,
): Promise<string | null> {
  if (ref === undefined) {
    // Field omitted from PATCH — caller should not call this for omitted fields.
    return null;
  }
  if (ref === null) {
    return null;
  }

  const id = typeof ref.id === 'string' && ref.id.trim() ? ref.id.trim() : null;
  const name = typeof ref.name === 'string' && ref.name.trim() ? ref.name.trim() : null;

  if (!id && !name) {
    return null;
  }

  if (id) {
    const row = await tx.productAttributeValue.findUnique({ where: { id } });
    if (!row || row.kind !== kind) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Характеристика не найдена или неверного типа',
        { kind, id },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (attrRequiresParent(kind)) {
      const expected = parentKeyFor(parentId);
      if (row.parentKey !== expected) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Значение не совместимо с выбранным видом цветка',
          { kind, id },
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return row.id;
  }

  const created = await createOrGetAttributeValue(tx, kind, name!, parentId);
  return created.id;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
