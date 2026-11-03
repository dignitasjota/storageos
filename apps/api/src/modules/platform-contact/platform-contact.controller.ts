import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  SubmitPlatformContactSchema,
  UpdatePlatformContactSettingsSchema,
  type PlatformContactMessageDto,
  type PlatformContactMessagesPageDto,
  type PlatformContactSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';
import { AdminAudit } from '../admin/admin-audit.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { PlatformContactService } from './platform-contact.service';

import type { Request } from 'express';

class SubmitContactDto extends createZodDto(SubmitPlatformContactSchema) {}
class UpdateContactSettingsDto extends createZodDto(UpdatePlatformContactSettingsSchema) {}
class HandledDto extends createZodDto(z.object({ handled: z.boolean() })) {}

/** Envío del formulario de contacto de la web de TrasterOS. */
@Public()
@Controller('platform-contact')
export class PlatformContactPublicController {
  constructor(private readonly service: PlatformContactService) {}

  @ThrottleLogin()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async submit(@Body() body: SubmitContactDto, @Req() req: Request): Promise<void> {
    await this.service.submit(body, req.ip ?? null);
  }
}

/** Ajustes del formulario y bandeja de mensajes. Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform/contact')
export class PlatformContactAdminController {
  constructor(private readonly service: PlatformContactService) {}

  @Get()
  getSettings(): Promise<PlatformContactSettingsDto> {
    return this.service.getSettings();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.contact_settings_updated')
  @Put()
  updateSettings(@Body() body: UpdateContactSettingsDto): Promise<PlatformContactSettingsDto> {
    return this.service.updateSettings(body);
  }

  /** Bandeja de 30 en 30, con buscador y filtro sin atender / atendidos. */
  @Get('messages')
  listMessages(
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
    @Query('handled') handled?: string,
  ): Promise<PlatformContactMessagesPageDto> {
    if (cursor && !/^[0-9a-f-]{36}$/i.test(cursor)) {
      throw new BadRequestException({ code: 'invalid_cursor', message: 'Cursor no válido' });
    }
    return this.service.listMessages({
      ...(cursor ? { cursor } : {}),
      ...(search?.trim() ? { search: search.trim() } : {}),
      ...(handled === 'true' || handled === 'false' ? { handled: handled === 'true' } : {}),
    });
  }

  /** Borra un mensaje (datos de un visitante; RGPD). */
  @RequireSuperadmin()
  @AdminAudit('admin.platform.contact_message_deleted')
  @Delete('messages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMessage(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.deleteMessage(id);
  }

  @AdminAudit('admin.platform.contact_message_handled')
  @Post('messages/:id/handled')
  @HttpCode(HttpStatus.OK)
  setHandled(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: HandledDto,
  ): Promise<PlatformContactMessageDto> {
    return this.service.setHandled(id, body.handled);
  }
}
