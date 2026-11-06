import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AdminCommsService } from './admin-comms.service';

import type { TenantPlatformMessagesPageDto } from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cara tenant de los mensajes de TrasterOS (correo directo, anuncios,
 * retención): Soporte → «Mensajes de TrasterOS». Solo los del tenant del JWT,
 * y solo para quien lleva la cuenta (propietario y gestor).
 */
@RequirePermission('platform_messages:manage')
@Controller('support/platform-messages')
export class PlatformMessagesTenantController {
  constructor(private readonly comms: AdminCommsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
  ): Promise<TenantPlatformMessagesPageDto> {
    if (cursor && !UUID_RE.test(cursor)) {
      throw new BadRequestException({ code: 'invalid_cursor', message: 'Cursor no válido' });
    }
    return this.comms.listForTenant(user.tenantId, user.sub, cursor);
  }

  /** URL firmada (10 min) para descargar un adjunto. */
  @Get(':id/attachments/:index')
  async attachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<{ url: string }> {
    return { url: await this.comms.platformMessageFileUrl(user.tenantId, id, index) };
  }

  /** Deja leídos todos los mensajes para quien los abre. */
  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.comms.markReadForTenant(user.tenantId, user.sub);
  }
}
