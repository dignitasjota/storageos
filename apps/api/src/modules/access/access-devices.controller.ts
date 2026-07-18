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
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertFacilityAllowed } from '../../common/facility-scope';

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
@RequireFeature('access_control')
export class AccessDevicesController {
  constructor(private readonly service: AccessDevicesService) {}

  @RequirePermission('access:read')
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('access:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AccessDeviceDto> {
    return this.service.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  @Post()
  @RequirePermission('access:manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateDeviceDto,
    @Req() req: Request,
  ): Promise<AccessDeviceWithKeyDto> {
    assertFacilityAllowed(user.facilityScope, body.facilityId);
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch(':id')
  @RequirePermission('access:manage')
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Delete(':id')
  @RequirePermission('access:manage')
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Post(':id/regenerate-api-key')
  @RequirePermission('access:manage')
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Post(':id/ping')
  @RequirePermission('access:read')
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  // Apertura remota disparada por el staff (server → controlador).
  @Post(':id/open')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  open(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<{ dispatched: boolean; message?: string }> {
    return this.service.remoteOpen({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  // Cierre remoto / lockdown disparado por el staff.
  @Post(':id/close')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<{ dispatched: boolean; message?: string }> {
    return this.service.remoteClose({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }
}
