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
  type AccessDeviceDto,
  AccessDeviceTypeEnum,
  type AccessDeviceTypeValue,
  type AccessDeviceWithKeyDto,
  CreateDeviceSchema,
  UpdateDeviceSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { AccessDevicesService } from './access-devices.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateDeviceDto extends createZodDto(CreateDeviceSchema) {}
class UpdateDeviceDto extends createZodDto(UpdateDeviceSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

function parseType(value: string | undefined): AccessDeviceTypeValue | undefined {
  if (!value) return undefined;
  const parsed = AccessDeviceTypeEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

@Controller('access/devices')
export class AccessDevicesController {
  constructor(private readonly service: AccessDevicesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('type') type?: string,
    @Query('isOnline') isOnline?: string,
  ): Promise<AccessDeviceDto[]> {
    const parsedType = parseType(type);
    const parsedOnline = parseBool(isOnline);
    return this.service.list(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      ...(parsedType ? { type: parsedType } : {}),
      ...(parsedOnline !== undefined ? { isOnline: parsedOnline } : {}),
    });
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AccessDeviceDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post()
  @Roles('owner', 'manager')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateDeviceDto,
    @Req() req: Request,
  ): Promise<AccessDeviceWithKeyDto> {
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
    @Body() body: UpdateDeviceDto,
    @Req() req: Request,
  ): Promise<AccessDeviceDto> {
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

  @Post(':id/regenerate-api-key')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  regenerateApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AccessDeviceWithKeyDto> {
    return this.service.regenerateApiKey({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }

  @Post(':id/ping')
  @Roles('owner', 'manager', 'staff')
  @HttpCode(HttpStatus.OK)
  ping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<{ online: boolean }> {
    return this.service.ping({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }
}
