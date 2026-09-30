import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UpdateCustomerEmailSettingsSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerEmailsService } from './customer-emails.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { CustomerEmailSettingsDto } from '@storageos/shared';

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
