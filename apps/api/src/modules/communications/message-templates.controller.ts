import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  CreateMessageTemplateSchema,
  type MessageTemplateDto,
  PreviewMessageTemplateSchema,
  UpdateMessageTemplateSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { MessageTemplatesService } from './message-templates.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateMessageTemplateDto extends createZodDto(CreateMessageTemplateSchema) {}
class UpdateMessageTemplateDto extends createZodDto(UpdateMessageTemplateSchema) {}
class PreviewMessageTemplateDto extends createZodDto(PreviewMessageTemplateSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('message-templates')
export class MessageTemplatesController {
  constructor(private readonly service: MessageTemplatesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<MessageTemplateDto[]> {
    return this.service.list(user.tenantId);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MessageTemplateDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post()
  @Roles('owner', 'manager')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateMessageTemplateDto,
    @Req() req: Request,
  ): Promise<MessageTemplateDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateMessageTemplateDto,
    @Req() req: Request,
  ): Promise<MessageTemplateDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() body: PreviewMessageTemplateDto): {
    subject: string;
    bodyText: string;
    bodyHtml: string;
  } {
    return this.service.preview(body);
  }
}
