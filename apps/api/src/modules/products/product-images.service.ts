import { HttpStatus, Injectable, Logger, OnModuleInit, StreamableFile } from '@nestjs/common';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, unlink, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Prisma } from '@erp/database';
import type { ProductImageDto } from '@erp/shared';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 2048;
const THUMB_SIZE = 256;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGES_PER_PRODUCT = 8;

@Injectable()
export class ProductImagesService implements OnModuleInit {
  private readonly logger = new Logger(ProductImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureUploadsDir();
    try {
      const removed = await this.cleanupStagedOrphans();
      if (removed > 0) {
        this.logger.log(`Removed ${removed} staged orphan product image(s)`);
      }
    } catch (error) {
      this.logger.warn(`Staged image cleanup skipped: ${(error as Error).message}`);
    }
  }

  uploadsRoot(): string {
    return this.config.uploadsDir;
  }

  private imagesDir(): string {
    return join(this.uploadsRoot(), 'product-images');
  }

  fullPath(id: string): string {
    return join(this.imagesDir(), `${id}.webp`);
  }

  thumbPath(id: string): string {
    return join(this.imagesDir(), `${id}.thumb.webp`);
  }

  toDto(
    row: {
      id: string;
      mimeType: string;
      byteSize: number;
      width: number | null;
      height: number | null;
      sortOrder: number;
    },
    primaryImageId: string | null | undefined,
  ): ProductImageDto {
    return {
      id: row.id,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      width: row.width,
      height: row.height,
      sortOrder: row.sortOrder,
      url: `/api/v1/product-images/${row.id}`,
      thumbUrl: `/api/v1/product-images/${row.id}?variant=thumb`,
      isPrimary: primaryImageId === row.id,
    };
  }

  async uploadStaged(file: Express.Multer.File | undefined): Promise<ProductImageDto> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Файл изображения обязателен',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    if (file.size > MAX_BYTES || file.buffer.length > MAX_BYTES) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Размер изображения не должен превышать 8 МБ',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Допустимы JPEG, PNG, WebP и GIF',
        { mime },
        HttpStatus.BAD_REQUEST,
      );
    }

    let pipeline = sharp(file.buffer, { failOn: 'error', animated: false }).rotate();
    const meta = await pipeline.metadata();
    if (!meta.width || !meta.height) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Не удалось прочитать изображение',
        {},
        HttpStatus.BAD_REQUEST,
      );
    }

    // Re-decode via sharp to strip metadata / polyglots.
    pipeline = sharp(file.buffer, { failOn: 'error', animated: false }).rotate();
    if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
      pipeline = pipeline.resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const fullBuffer = await pipeline.webp({ quality: 82 }).toBuffer();
    const fullMeta = await sharp(fullBuffer).metadata();

    const thumbBuffer = await sharp(fullBuffer)
      .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'cover' })
      .webp({ quality: 75 })
      .toBuffer();

    await this.ensureUploadsDir();
    const id = randomUUID().replace(/-/g, '').slice(0, 24);

    const row = await this.prisma.productImage.create({
      data: {
        id,
        productId: null,
        mimeType: 'image/webp',
        byteSize: fullBuffer.length,
        width: fullMeta.width ?? null,
        height: fullMeta.height ?? null,
        sortOrder: 0,
      },
    });

    try {
      await writeFile(this.fullPath(id), fullBuffer);
      await writeFile(this.thumbPath(id), thumbBuffer);
    } catch (error) {
      await this.prisma.productImage.delete({ where: { id } }).catch(() => undefined);
      throw error;
    }

    return this.toDto(row, null);
  }

  async stream(id: string, variant: 'full' | 'thumb'): Promise<StreamableFile> {
    const row = await this.prisma.productImage.findUnique({ where: { id } });
    if (!row) {
      throw new AppError(
        'PRODUCT_IMAGE_NOT_FOUND',
        'Изображение не найдено',
        {},
        HttpStatus.NOT_FOUND,
      );
    }
    const path = variant === 'thumb' ? this.thumbPath(id) : this.fullPath(id);
    const fallback = this.fullPath(id);
    const filePath = existsSync(path) ? path : fallback;
    if (!existsSync(filePath)) {
      throw new AppError(
        'PRODUCT_IMAGE_NOT_FOUND',
        'Файл изображения отсутствует',
        {},
        HttpStatus.NOT_FOUND,
      );
    }
    const info = await stat(filePath);
    return new StreamableFile(createReadStream(filePath), {
      type: 'image/webp',
      length: info.size,
      disposition: `inline; filename="${id}.webp"`,
    });
  }

  async deleteImage(id: string): Promise<void> {
    const row = await this.prisma.productImage.findUnique({
      where: { id },
      include: { primaryFor: { select: { id: true } } },
    });
    if (!row) {
      throw new AppError(
        'PRODUCT_IMAGE_NOT_FOUND',
        'Изображение не найдено',
        {},
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (row.primaryFor) {
        await tx.product.update({
          where: { id: row.primaryFor.id },
          data: { primaryImageId: null },
        });
      }
      await tx.productImage.delete({ where: { id } });
    });

    await this.unlinkQuiet(this.fullPath(id));
    await this.unlinkQuiet(this.thumbPath(id));
  }

  /**
   * Attach staged image ids to a product; optionally set primary and remove others.
   */
  async syncProductImages(
    tx: Prisma.TransactionClient,
    productId: string,
    options: {
      imageIds?: string[];
      primaryImageId?: string | null;
      removeImageIds?: string[];
    },
  ): Promise<void> {
    if (options.removeImageIds?.length) {
      const toRemove = await tx.productImage.findMany({
        where: {
          id: { in: options.removeImageIds },
          OR: [{ productId }, { productId: null }],
        },
      });
      for (const img of toRemove) {
        if (img.productId === productId || img.productId === null) {
          await tx.product.updateMany({
            where: { id: productId, primaryImageId: img.id },
            data: { primaryImageId: null },
          });
          await tx.productImage.delete({ where: { id: img.id } });
          await this.unlinkQuiet(this.fullPath(img.id));
          await this.unlinkQuiet(this.thumbPath(img.id));
        }
      }
    }

    if (options.imageIds) {
      if (options.imageIds.length > MAX_IMAGES_PER_PRODUCT) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Не больше ${MAX_IMAGES_PER_PRODUCT} изображений на товар`,
          {},
          HttpStatus.BAD_REQUEST,
        );
      }

      const uniqueIds = [...new Set(options.imageIds)];
      const images = await tx.productImage.findMany({ where: { id: { in: uniqueIds } } });
      if (images.length !== uniqueIds.length) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Одно или несколько изображений не найдены',
          {},
          HttpStatus.BAD_REQUEST,
        );
      }

      for (const img of images) {
        if (img.productId && img.productId !== productId) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Изображение уже привязано к другому товару',
            { imageId: img.id },
            HttpStatus.CONFLICT,
          );
        }
      }

      // Detach images no longer in the list (keep only listed for this product).
      const current = await tx.productImage.findMany({ where: { productId } });
      for (const img of current) {
        if (!uniqueIds.includes(img.id)) {
          await tx.product.updateMany({
            where: { id: productId, primaryImageId: img.id },
            data: { primaryImageId: null },
          });
          await tx.productImage.delete({ where: { id: img.id } });
          await this.unlinkQuiet(this.fullPath(img.id));
          await this.unlinkQuiet(this.thumbPath(img.id));
        }
      }

      let order = 0;
      for (const id of uniqueIds) {
        await tx.productImage.update({
          where: { id },
          data: { productId, sortOrder: order },
        });
        order += 1;
      }
    }

    if (options.primaryImageId !== undefined) {
      if (options.primaryImageId === null) {
        await tx.product.update({
          where: { id: productId },
          data: { primaryImageId: null },
        });
      } else {
        const img = await tx.productImage.findUnique({ where: { id: options.primaryImageId } });
        if (!img || img.productId !== productId) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Основное изображение должно принадлежать товару',
            {},
            HttpStatus.BAD_REQUEST,
          );
        }
        await tx.product.update({
          where: { id: productId },
          data: { primaryImageId: options.primaryImageId },
        });
      }
    } else if (options.imageIds && options.imageIds.length > 0) {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (product && !product.primaryImageId) {
        await tx.product.update({
          where: { id: productId },
          data: { primaryImageId: options.imageIds[0] },
        });
      }
    }
  }

  async cleanupStagedOrphans(): Promise<number> {
    const cutoff = new Date(Date.now() - STAGED_TTL_MS);
    const orphans = await this.prisma.productImage.findMany({
      where: { productId: null, createdAt: { lt: cutoff } },
      select: { id: true },
    });
    for (const orphan of orphans) {
      await this.prisma.productImage.delete({ where: { id: orphan.id } }).catch(() => undefined);
      await this.unlinkQuiet(this.fullPath(orphan.id));
      await this.unlinkQuiet(this.thumbPath(orphan.id));
    }
    return orphans.length;
  }

  private async ensureUploadsDir(): Promise<void> {
    await mkdir(this.imagesDir(), { recursive: true });
  }

  private async unlinkQuiet(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // ignore missing files
    }
  }
}
