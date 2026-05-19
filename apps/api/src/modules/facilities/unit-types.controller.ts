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
import { CreateUnitTypeSchema, type UnitTypeDto, UpdateUnitTypeSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { UnitTypesService } from './unit-types.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateUnitTypeDto extends createZodDto(CreateUnitTypeSchema) {}
class UpdateUnitTypeDto extends createZodDto(UpdateUnitTypeSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('unit-types')
export class UnitTypesController {
  constructor(private readonly unitTypes: UnitTypesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<UnitTypeDto[]> {
    return this.unitTypes.list(user.tenantId);
  }

  @Roles('owner', 'manager')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateUnitTypeDto,
    @Req() req: Request,
  ): Promise<UnitTypeDto> {
    return this.unitTypes.create({
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
    @Body() input: UpdateUnitTypeDto,
    @Req() req: Request,
  ): Promise<UnitTypeDto> {
    return this.unitTypes.update({
      tenantId: user.tenantId,
      userId: user.sub,
      unitTypeId: id,
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
    await this.unitTypes.deleteOrDeactivate({
      tenantId: user.tenantId,
      userId: user.sub,
      unitTypeId: id,
      meta: extractMeta(req),
    });
  }
}
