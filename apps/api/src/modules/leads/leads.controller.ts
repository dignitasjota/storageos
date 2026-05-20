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
  ConvertLeadSchema,
  CreateLeadSchema,
  type LeadDto,
  type LeadSourceValue,
  type LeadStatusValue,
  TransitionLeadSchema,
  UpdateLeadSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { LeadsService } from './leads.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateLeadDto extends createZodDto(CreateLeadSchema) {}
class UpdateLeadDto extends createZodDto(UpdateLeadSchema) {}
class TransitionLeadDto extends createZodDto(TransitionLeadSchema) {}
class ConvertLeadDto extends createZodDto(ConvertLeadSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('leads')
export class LeadsController {
  constructor(private readonly service: LeadsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
  ): Promise<LeadDto[]> {
    return this.service.list(user.tenantId, {
      ...(status ? { status: status as LeadStatusValue } : {}),
      ...(assignedToUserId ? { assignedToUserId } : {}),
      ...(source ? { source: source as LeadSourceValue } : {}),
      ...(search ? { search } : {}),
    });
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post()
  @Roles('owner', 'manager', 'staff')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch(':id')
  @Roles('owner', 'manager', 'staff')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Post(':id/transition')
  @Roles('owner', 'manager', 'staff')
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TransitionLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.transition({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Post(':id/convert')
  @Roles('owner', 'manager', 'staff')
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ConvertLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.convert({
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
}
