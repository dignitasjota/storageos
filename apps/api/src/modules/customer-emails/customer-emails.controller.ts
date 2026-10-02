import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  UpdateCustomerEmailSettingsSchema,
  UpdateStaffEmailSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerEmailsService } from './customer-emails.service';
import { StaffEmailsService } from './staff-emails.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  CustomerEmailSettingsDto,
  MyEmailNoticesDto,
  StaffEmailSettingsDto,
} from '@storageos/shared';

class UpdateCustomerEmailSettingsDto extends createZodDto(UpdateCustomerEmailSettingsSchema) {}

/** Qué correos automáticos reciben los inquilinos del tenant. */
@Controller('settings/tenant/customer-emails')
export class CustomerEmailsController {
  constructor(private readonly service: CustomerEmailsService) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<CustomerEmailSettingsDto> {
    return this.service.getSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateCustomerEmailSettingsDto,
  ): Promise<CustomerEmailSettingsDto> {
    return this.service.updateSettings(user.tenantId, user.sub, body);
  }
}

class UpdateStaffEmailSettingsDto extends createZodDto(UpdateStaffEmailSettingsSchema) {}

/** Qué avisos por email recibe el equipo (propietarios y gestores). */
@Controller('settings/tenant/staff-emails')
export class StaffEmailsController {
  constructor(private readonly service: StaffEmailsService) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<StaffEmailSettingsDto> {
    return this.service.getSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateStaffEmailSettingsDto,
  ): Promise<StaffEmailSettingsDto> {
    return this.service.updateSettings(user.tenantId, user.sub, body);
  }
}

/** Avisos por correo que recibe el usuario (su perfil; sin permiso especial). */
@Controller('me/email-notices')
export class MyEmailNoticesController {
  constructor(private readonly staff: StaffEmailsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<MyEmailNoticesDto> {
    return this.staff.getMyNotices(user.tenantId, user.sub);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateStaffEmailSettingsDto,
  ): Promise<MyEmailNoticesDto> {
    return this.staff.updateMyNotices(user.tenantId, user.sub, body);
  }
}
