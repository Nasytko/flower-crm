import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import { memoryStorage } from 'multer';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { ProductImagesService } from './product-images.service';

@ApiTags('product-images')
@ApiBearerAuth()
@Controller('product-images')
export class ProductImagesController {
  constructor(private readonly images: ProductImagesService) {}

  @Post()
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @ApiOperation({ summary: 'Upload staged product image (attach on product save)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.images.uploadStaged(file);
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCTS_VIEW)
  @ApiOperation({ summary: 'Stream product image (full or thumb)' })
  stream(@Param('id') id: string, @Query('variant') variant?: string) {
    const v = variant === 'thumb' ? 'thumb' : 'full';
    return this.images.stream(id, v);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.PRODUCTS_MANAGE)
  @ApiOperation({ summary: 'Delete staged or attached product image' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.images.deleteImage(id);
  }
}
