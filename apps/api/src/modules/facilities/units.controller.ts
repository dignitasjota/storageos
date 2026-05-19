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
  ChangeUnitStatusSchema,
  CreateUnitSchema,
  type UnitDto,
  type UnitStatusHistoryDto,
  UnitStatusEnum,
  UpdateUnitSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { UnitsService } from './units.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateUnitDto extends createZodDto(CreateUnitSchema) {}
class UpdateUnitDto extends createZodDto(UpdateUnitSchema) {}
class ChangeUnitStatusDto extends createZodDto(ChangeUnitStatusSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('floorId') floorId?: string,
    @Query('unitTypeId') unitTypeId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: UnitDto[]; nextCursor: string | null }> {
    const parsedStatus = status ? UnitStatusEnum.parse(status) : undefined;
    return this.units.list(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      ...(floorId ? { floorId } : {}),
      ...(unitTypeId ? { unitTypeId } : {}),
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {}),
    });
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UnitDto> {
    return this.units.detail(user.tenantId, id);
  }

  @Get(':id/history')
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UnitStatusHistoryDto[]> {
    return this.units.history(user.tenantId, id);
  }

  @Roles('owner', 'manager')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateUnitDto,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return this.units.create({
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
    @Body() input: UpdateUnitDto,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return this.units.update({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager', 'staff')
  @Post(':id/change-status')
  @HttpCode(HttpStatus.OK)
  async changeStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ChangeUnitStatusDto,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return this.units.changeStatus({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
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
    await this.units.delete({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      meta: extractMeta(req),
    });
  }
}
