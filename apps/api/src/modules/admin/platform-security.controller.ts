import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  type PlatformSecuritySettingsDto,
  UpdatePlatformSecuritySettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { PlatformSecurityService } from './platform-security.service';
import { AllowWithoutTwoFactor, RequireSuperadmin } from './require-superadmin.decorator';

class UpdatePlatformSecuritySettingsDto extends createZodDto(
  UpdatePlatformSecuritySettingsSchema,
) {}

@Public()
@UseGuards(AdminGuard)
@Controller('admin/security-settings')
export class PlatformSecurityController {
  constructor(private readonly security: PlatformSecurityService) {}

  @AllowWithoutTwoFactor()
  @Get()
  get(): Promise<PlatformSecuritySettingsDto> {
    return this.security.get();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.security_settings.updated')
  @Put()
  update(
    @CurrentSuperAdmin() actor: AuthenticatedSuperAdmin,
    @Body() input: UpdatePlatformSecuritySettingsDto,
  ): Promise<PlatformSecuritySettingsDto> {
    return this.security.update(actor.sub, input);
  }
}
