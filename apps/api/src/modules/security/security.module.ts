import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { SecurityController } from './security.controller';
import { SecurityPolicyService } from './security-policy.service';
import { TrustedDeviceService } from './trusted-device.service';
import { WorkstationService } from './workstation.service';
import { EmployeePinService } from './employee-pin.service';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [SecurityController],
  providers: [
    SecurityPolicyService,
    TrustedDeviceService,
    WorkstationService,
    EmployeePinService,
  ],
  exports: [
    SecurityPolicyService,
    TrustedDeviceService,
    WorkstationService,
    EmployeePinService,
  ],
})
export class SecurityModule {}
