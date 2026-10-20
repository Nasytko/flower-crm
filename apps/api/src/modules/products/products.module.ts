import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProductAttributesController } from './product-attributes.controller';
import { ProductAttributesService } from './product-attributes.service';
import { ProductImagesController } from './product-images.controller';
import { ProductImagesService } from './product-images.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [AuditModule],
  controllers: [ProductsController, ProductAttributesController, ProductImagesController],
  providers: [ProductsService, ProductAttributesService, ProductImagesService],
  exports: [ProductsService, ProductImagesService],
})
export class ProductsModule {}
