import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { ProductAttributeQueryDto } from './dto/product-attribute.dto';
import { ProductAttributesService } from './product-attributes.service';

@ApiTags('product-attributes')
@ApiBearerAuth()
@Controller('product-attributes')
export class ProductAttributesController {
  constructor(private readonly attributes: ProductAttributesService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCTS_VIEW)
  @ApiOperation({ summary: 'List flower attribute values for creatable selects' })
  list(@Query() query: ProductAttributeQueryDto) {
    return this.attributes.list({
      kind: query.kind,
      parentId: query.parentId,
      search: query.search,
      limit: query.limit,
    });
  }
}
