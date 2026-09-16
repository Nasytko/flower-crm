import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { SettingsController } from './settings.controller';

@Module({
  imports: [HealthModule],
  controllers: [SettingsController],
})
export class SettingsModule {}
