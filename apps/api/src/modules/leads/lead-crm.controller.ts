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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateLeadActivitySchema,
  CreateLeadFollowupSchema,
  LinkLeadCustomerSchema,
  MergeLeadSchema,
  UpdateLeadFollowupSchema,
  UpdateLeadSettingsSchema,
  type LeadActivityDto,
  type LeadDuplicateGroupDto,
  type LeadFollowupDto,
  type LeadResponseStatsDto,
  type LeadSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { LeadCrmService } from './lead-crm.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateLeadFollowupDto extends createZodDto(CreateLeadFollowupSchema) {}
class UpdateLeadFollowupDto extends createZodDto(UpdateLeadFollowupSchema) {}
class CreateLeadActivityDto extends createZodDto(CreateLeadActivitySchema) {}
class UpdateLeadSettingsDto extends createZodDto(UpdateLeadSettingsSchema) {}
class MergeLeadDto extends createZodDto(MergeLeadSchema) {}
class LinkLeadCustomerDto extends createZodDto(LinkLeadCustomerSchema) {}

function meta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  return { ...(ua ? { userAgent: ua } : {}), ...(req.ip ? { ipAddress: req.ip } : {}) };
}

/**
 * Seguimiento comercial de los contactos. Se registra antes que
 * `LeadsController` para que sus rutas fijas no las capture `:id`.
 */
@Controller('leads')
export class LeadCrmController {
  constructor(private readonly crm: LeadCrmService) {}

  @Get('settings')
  @RequirePermission('leads:read')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<LeadSettingsDto> {
    return this.crm.getSettings(user.tenantId);
  }

  @Put('settings')
  @RequirePermission('settings:manage')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateLeadSettingsDto,
    @Req() req: Request,
  ): Promise<LeadSettingsDto> {
    return this.crm.updateSettings({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: meta(req),
    });
  }

  @Get('response-stats')
  @RequirePermission('leads:read')
  responseStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<LeadResponseStatsDto> {
    return this.crm.responseStats(user.tenantId, Number(days ?? 30));
  }

  @Get('duplicates')
  @RequirePermission('leads:read')
  duplicates(@CurrentUser() user: AuthenticatedUser): Promise<LeadDuplicateGroupDto[]> {
    return this.crm.duplicates(user.tenantId);
  }

  @Get('followups/pending')
  @RequirePermission('leads:read')
  pendingFollowups(@CurrentUser() user: AuthenticatedUser): Promise<LeadFollowupDto[]> {
    return this.crm.listPendingFollowups(user.tenantId);
  }

  @Patch('followups/:followupId')
  @RequirePermission('leads:write')
  setFollowupStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('followupId', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateLeadFollowupDto,
  ): Promise<LeadFollowupDto> {
    return this.crm.setFollowupStatus(user.tenantId, id, input);
  }

  @Delete('followups/:followupId')
  @RequirePermission('leads:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFollowup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('followupId', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.crm.removeFollowup(user.tenantId, id);
  }

  @Get(':id/followups')
  @RequirePermission('leads:read')
  followups(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadFollowupDto[]> {
    return this.crm.listFollowups(user.tenantId, id);
  }

  @Post(':id/followups')
  @RequirePermission('leads:write')
  createFollowup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateLeadFollowupDto,
  ): Promise<LeadFollowupDto> {
    return this.crm.createFollowup({
      tenantId: user.tenantId,
      userId: user.sub,
      leadId: id,
      input,
    });
  }

  @Get(':id/activities')
  @RequirePermission('leads:read')
  activities(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadActivityDto[]> {
    return this.crm.listActivities(user.tenantId, id);
  }

  @Post(':id/activities')
  @RequirePermission('leads:write')
  createActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateLeadActivityDto,
  ): Promise<LeadActivityDto> {
    return this.crm.createActivity({
      tenantId: user.tenantId,
      userId: user.sub,
      leadId: id,
      input,
    });
  }

  @Delete(':id/activities/:activityId')
  @RequirePermission('leads:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('activityId', new ParseUUIDPipe()) activityId: string,
  ): Promise<void> {
    await this.crm.removeActivity(user.tenantId, id, activityId);
  }

  @Post(':id/merge')
  @RequirePermission('leads:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: MergeLeadDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.crm.merge({
      tenantId: user.tenantId,
      userId: user.sub,
      sourceId: id,
      intoLeadId: input.intoLeadId,
      meta: meta(req),
    });
  }

  @Post(':id/link-customer')
  @RequirePermission('leads:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async linkCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: LinkLeadCustomerDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.crm.linkCustomer({
      tenantId: user.tenantId,
      userId: user.sub,
      leadId: id,
      customerId: input.customerId,
      meta: meta(req),
    });
  }
}
