import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateHelpTopicSchema,
  HELP_TOPIC_ID_RE,
  RequestHelpImageUploadSchema,
  UpdateHelpTopicSchema,
  type AdminHelpTopicDto,
  type HelpImageUploadDto,
  type HelpTopicDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import {
  CurrentSuperAdmin,
  type AuthenticatedSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';

import { HelpTopicsService } from './help-topics.service';

import type { Request } from 'express';

class CreateHelpTopicDto extends createZodDto(CreateHelpTopicSchema) {}
class UpdateHelpTopicDto extends createZodDto(UpdateHelpTopicSchema) {}
class RequestHelpImageUploadDto extends createZodDto(RequestHelpImageUploadSchema) {}

function parseTopicId(topicId: string): string {
  if (topicId.length > 60 || !HELP_TOPIC_ID_RE.test(topicId)) {
    throw new BadRequestException({ code: 'invalid_help_topic', message: 'Guía no válida' });
  }
  return topicId;
}

/** Guías de «Cómo funciona» para cualquier usuario del panel del tenant. */
@Controller('help-topics')
export class HelpTopicsController {
  constructor(private readonly service: HelpTopicsService) {}

  @Get()
  list(): Promise<HelpTopicDto[]> {
    return this.service.listForTenant();
  }
}

/** Edición de las guías desde el panel de administración (escribir: superadmin). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/help-topics')
export class AdminHelpTopicsController {
  constructor(
    private readonly service: HelpTopicsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Get()
  list(): Promise<AdminHelpTopicDto[]> {
    return this.service.listForAdmin();
  }

  @RequireSuperadmin()
  @Post('image-upload-url')
  @HttpCode(HttpStatus.OK)
  requestImageUpload(@Body() body: RequestHelpImageUploadDto): Promise<HelpImageUploadDto> {
    return this.service.requestImageUpload(body.mimeType);
  }

  @RequireSuperadmin()
  @Post()
  async create(
    @Body() body: CreateHelpTopicDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<AdminHelpTopicDto> {
    const topic = await this.service.create(body);
    await this.record(admin, req, 'admin.help_topic.created', topic.id, Object.keys(body));
    return topic;
  }

  @RequireSuperadmin()
  @Put(':topicId')
  async update(
    @Param('topicId') topicId: string,
    @Body() body: UpdateHelpTopicDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<AdminHelpTopicDto> {
    const topic = await this.service.update(parseTopicId(topicId), body);
    await this.record(admin, req, 'admin.help_topic.updated', topic.id, Object.keys(body));
    return topic;
  }

  @RequireSuperadmin()
  @Delete(':topicId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('topicId') topicId: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<void> {
    const id = parseTopicId(topicId);
    await this.service.remove(id);
    await this.record(admin, req, 'admin.help_topic.reset', id, []);
  }

  private record(
    admin: AuthenticatedSuperAdmin,
    req: Request,
    action: string,
    topicId: string,
    fields: string[],
  ): Promise<void> {
    return this.audit.record({
      superAdminId: admin.sub,
      action,
      targetType: 'PlatformHelpTopic',
      changes: { topicId, ...(fields.length > 0 ? { fields } : {}) },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
