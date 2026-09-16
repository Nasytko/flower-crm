import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@erp/shared';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditListResult, AuditQueryService } from './audit-query.service';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly auditQuery: AuditQueryService) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_VIEW)
  @ApiOperation({ summary: 'List audit log entries' })
  list(@Query() query: AuditQueryDto): Promise<AuditListResult> {
    return this.auditQuery.list(query);
  }
}
