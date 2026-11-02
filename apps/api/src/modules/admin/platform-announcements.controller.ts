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
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminDirectFileUploadSchema,
  AnnouncementPreviewSchema,
  SavePlatformAnnouncementSchema,
  SendPlatformAnnouncementSchema,
  type AdminBroadcastResultDto,
  type AnnouncementPreviewDto,
  type PlatformAnnouncementDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminCommsService } from './admin-comms.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { PlatformAnnouncementsService } from './platform-announcements.service';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Request } from 'express';

class SaveAnnouncementDto extends createZodDto(SavePlatformAnnouncementSchema) {}
class SendAnnouncementDto extends createZodDto(SendPlatformAnnouncementSchema) {}
class PreviewDto extends createZodDto(AnnouncementPreviewSchema) {}
class DirectFileUploadDto extends createZodDto(AdminDirectFileUploadSchema) {}

function meta(admin: AuthenticatedSuperAdmin, req: Request) {
  return {
    superAdminId: admin.sub,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

/** Historial de anuncios a los tenants (escribir: rol superadmin). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class PlatformAnnouncementsController {
  constructor(
    private readonly announcements: PlatformAnnouncementsService,
    private readonly comms: AdminCommsService,
  ) {}

  @Get('announcements/history')
  list(): Promise<PlatformAnnouncementDto[]> {
    return this.announcements.list();
  }

  @Post('announcements/preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() body: PreviewDto): Promise<AnnouncementPreviewDto> {
    return this.announcements.preview(body);
  }

  @Post('announcements/drafts')
  @RequireSuperadmin()
  create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: SaveAnnouncementDto,
  ): Promise<PlatformAnnouncementDto> {
    return this.announcements.create(body, admin.sub);
  }

  @Get('announcements/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformAnnouncementDto> {
    return this.announcements.get(id);
  }

  @Put('announcements/:id')
  @RequireSuperadmin()
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SaveAnnouncementDto,
  ): Promise<PlatformAnnouncementDto> {
    return this.announcements.update(id, body);
  }

  @Delete('announcements/:id')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.announcements.remove(id);
  }

  @Post('announcements/:id/duplicate')
  @RequireSuperadmin()
  duplicate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PlatformAnnouncementDto> {
    return this.announcements.duplicate(id, admin.sub);
  }

  @Post('announcements/:id/send')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  send(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendAnnouncementDto,
    @Req() req: Request,
  ): Promise<PlatformAnnouncementDto> {
    return this.announcements.send(id, body.scheduledFor, meta(admin, req));
  }

  @Post('announcements/:id/cancel')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformAnnouncementDto> {
    return this.announcements.cancel(id);
  }

  @Post('announcements/:id/resend-missing')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  resendMissing(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AdminBroadcastResultDto> {
    return this.announcements.resendMissing(id, meta(admin, req));
  }

  /** Subida de un adjunto del correo directo a un tenant. */
  @Post('tenants/:id/email/upload-url')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  uploadUrl(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: DirectFileUploadDto) {
    return this.comms.requestDirectFileUpload(id, body);
  }
}
