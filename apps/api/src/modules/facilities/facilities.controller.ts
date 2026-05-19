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
import { CreateFacilitySchema, type FacilityDto, UpdateFacilitySchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { FacilitiesService } from './facilities.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateFacilityDto extends createZodDto(CreateFacilitySchema) {}
class UpdateFacilityDto extends createZodDto(UpdateFacilitySchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<FacilityDto[]> {
    return this.facilities.list(user.tenantId);
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<FacilityDto> {
    return this.facilities.detail(user.tenantId, id);
  }

  @Roles('owner', 'manager')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateFacilityDto,
    @Req() req: Request,
  ): Promise<FacilityDto> {
    return this.facilities.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateFacilityDto,
    @Req() req: Request,
  ): Promise<FacilityDto> {
    return this.facilities.update({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
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
    await this.facilities.softDelete({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      meta: extractMeta(req),
    });
  }
}
