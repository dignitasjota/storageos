import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CreateNpsSurveySchema,
  SubmitNpsResponseSchema,
  type NpsSurveyDetailDto,
  type NpsSurveyDto,
  type PublicNpsSurveyDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { PlatformNpsService } from './platform-nps.service';
import { RequireSuperadmin } from './require-superadmin.decorator';

class CreateNpsSurveyDto extends createZodDto(CreateNpsSurveySchema) {}
class SubmitNpsDto extends createZodDto(SubmitNpsResponseSchema) {}

/** Encuestas de satisfacción a los tenants (escribir: rol superadmin). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/nps-surveys')
export class PlatformNpsAdminController {
  constructor(private readonly nps: PlatformNpsService) {}

  @Get()
  list(): Promise<NpsSurveyDto[]> {
    return this.nps.list();
  }

  @Post()
  @RequireSuperadmin()
  create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: CreateNpsSurveyDto,
  ): Promise<NpsSurveyDto> {
    return this.nps.create(body, admin.sub);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<NpsSurveyDetailDto> {
    return this.nps.detail(id);
  }

  @Post(':id/send')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  send(@Param('id', new ParseUUIDPipe()) id: string): Promise<NpsSurveyDto> {
    return this.nps.send(id);
  }

  @Post(':id/close')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  close(@Param('id', new ParseUUIDPipe()) id: string): Promise<NpsSurveyDto> {
    return this.nps.close(id);
  }

  @Delete(':id')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.nps.remove(id);
  }
}

/** El enlace de la encuesta (sin sesión). */
@Public()
@Controller('public/platform-nps')
export class PlatformNpsPublicController {
  constructor(private readonly nps: PlatformNpsService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  get(@Param('token') token: string): Promise<PublicNpsSurveyDto> {
    return this.nps.publicGet(token);
  }

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@Param('token') token: string, @Body() body: SubmitNpsDto): Promise<PublicNpsSurveyDto> {
    return this.nps.publicSubmit(token, body);
  }
}
