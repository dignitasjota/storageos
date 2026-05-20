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
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateIncidentSchema,
  IncidentCommentSchema,
  type IncidentCommentDto,
  type IncidentDto,
  IncidentSeverityEnum,
  type IncidentSeverityValue,
  IncidentStatusEnum,
  type IncidentStatusValue,
  TransitionIncidentSchema,
  UpdateIncidentSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { IncidentsService } from './incidents.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateIncidentDto extends createZodDto(CreateIncidentSchema) {}
class UpdateIncidentDto extends createZodDto(UpdateIncidentSchema) {}
class TransitionIncidentDto extends createZodDto(TransitionIncidentSchema) {}
class IncidentCommentDtoBody extends createZodDto(IncidentCommentSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

function parseStatus(value: string | undefined): IncidentStatusValue | undefined {
  if (!value) return undefined;
  const parsed = IncidentStatusEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseSeverity(value: string | undefined): IncidentSeverityValue | undefined {
  if (!value) return undefined;
  const parsed = IncidentSeverityEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('facilityId') facilityId?: string,
    @Query('unitId') unitId?: string,
    @Query('customerId') customerId?: string,
    @Query('contractId') contractId?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
  ): Promise<IncidentDto[]> {
    const parsedStatus = parseStatus(status);
    const parsedSeverity = parseSeverity(severity);
    return this.incidents.list(user.tenantId, {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(parsedSeverity ? { severity: parsedSeverity } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(unitId ? { unitId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(contractId ? { contractId } : {}),
      ...(assignedToUserId ? { assignedToUserId } : {}),
    });
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IncidentDto> {
    return this.incidents.detail(user.tenantId, id);
  }

  @Roles('owner', 'manager', 'staff')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateIncidentDto,
    @Req() req: Request,
  ): Promise<IncidentDto> {
    return this.incidents.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager', 'staff')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateIncidentDto,
    @Req() req: Request,
  ): Promise<IncidentDto> {
    return this.incidents.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager', 'staff')
  @Post(':id/transition')
  async transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: TransitionIncidentDto,
    @Req() req: Request,
  ): Promise<IncidentDto> {
    return this.incidents.transition({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.incidents.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }

  @Get(':id/comments')
  async listComments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IncidentCommentDto[]> {
    return this.incidents.listComments(user.tenantId, id);
  }

  @Post(':id/comments')
  async addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: IncidentCommentDtoBody,
    @Req() req: Request,
  ): Promise<IncidentCommentDto> {
    return this.incidents.addComment({
      tenantId: user.tenantId,
      userId: user.sub,
      incidentId: id,
      input,
      meta: extractMeta(req),
    });
  }
}
