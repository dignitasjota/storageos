import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  SubmitPlatformContactSchema,
  UpdatePlatformContactSettingsSchema,
  type PlatformContactMessageDto,
  type PlatformContactSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';
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
  @Put()
  updateSettings(@Body() body: UpdateContactSettingsDto): Promise<PlatformContactSettingsDto> {
    return this.service.updateSettings(body);
  }

  @Get('messages')
  listMessages(): Promise<PlatformContactMessageDto[]> {
    return this.service.listMessages();
  }

  @Post('messages/:id/handled')
  @HttpCode(HttpStatus.OK)
  setHandled(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: HandledDto,
  ): Promise<PlatformContactMessageDto> {
    return this.service.setHandled(id, body.handled);
  }
}
