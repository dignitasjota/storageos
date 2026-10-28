import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ConfigHealthService } from './config-health.service';
import { CustomDomainCheckService } from './custom-domain-check.service';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, TenantSettingsController],
  providers: [UsersService, TenantSettingsService, ConfigHealthService, CustomDomainCheckService],
  exports: [UsersService],
})
export class UsersModule {}
