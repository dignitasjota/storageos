import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { AdminCommsService } from './admin-comms.service';

import type { TenantPlatformMessageDto } from '@storageos/shared';

/**
 * Cara tenant de los mensajes de TrasterOS (correo directo, anuncios,
 * retención): Soporte → «Mensajes de TrasterOS». Solo los del tenant del JWT.
 */
@Controller('support/platform-messages')
export class PlatformMessagesTenantController {
  constructor(private readonly comms: AdminCommsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<TenantPlatformMessageDto[]> {
    return this.comms.listForTenant(user.tenantId);
  }
}
