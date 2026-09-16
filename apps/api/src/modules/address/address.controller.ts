import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { AddressService } from './address.service';
import { AddressSuggestQueryDto } from './dto/address.dto';

@ApiTags('address')
@ApiBearerAuth()
@Controller('address')
export class AddressController {
  constructor(private readonly addressService: AddressService) {}

  @Get('suggest')
  @RequirePermissions(Permission.ORDERS_VIEW)
  @ApiOperation({ summary: 'Street / place address suggestions (Nominatim BY)' })
  suggest(@Query() query: AddressSuggestQueryDto) {
    return this.addressService.suggest(query.q, query.limit ?? 7);
  }
}
