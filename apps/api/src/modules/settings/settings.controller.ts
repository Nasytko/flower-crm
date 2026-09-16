import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { API_PREFIX, Permission, type SystemSettingsDto } from '@erp/shared';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { AppConfigService } from '../../config/app-config.service';
import { HealthService } from '../health/health.service';

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly health: HealthService,
    private readonly config: AppConfigService,
  ) {}

  @Get('system')
  @RequirePermissions(Permission.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'System status and read-only runtime settings' })
  async getSystem(): Promise<SystemSettingsDto> {
    const health = await this.health.getHealth();
    return {
      health,
      businessTimeZone: this.config.businessTimeZone,
      nodeEnv: this.config.nodeEnv,
      webUrl: this.config.webUrl,
      apiPrefix: API_PREFIX,
    };
  }
}
