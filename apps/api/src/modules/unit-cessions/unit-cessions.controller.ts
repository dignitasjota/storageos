import {
  Body,
  Controller,
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
  CreateUnitCessionSchema,
  EndUnitCessionSchema,
  type UnitCessionCodeDto,
  type UnitCessionDto,
  UnitCessionListStatusEnum,
  UpdateUnitCessionSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertUuid } from '../../common/pagination';

import { UnitCessionsService } from './unit-cessions.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateUnitCessionDto extends createZodDto(CreateUnitCessionSchema) {}
class UpdateUnitCessionDto extends createZodDto(UpdateUnitCessionSchema) {}
class EndUnitCessionDto extends createZodDto(EndUnitCessionSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Cesión de un trastero (`/units/:id/cession`). Verla, quien ve trasteros; ceder,
 * ampliar, terminar y el acceso de la cesión, solo el propietario (lo comprueba
 * el servicio).
 */
@Controller('units/:id')
export class UnitCessionsController {
  constructor(private readonly cessions: UnitCessionsService) {}

  @RequirePermission('units:read')
  @Get('cession')
  async current(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ cession: UnitCessionDto | null }> {
    return { cession: await this.cessions.current(user.tenantId, id, user.facilityScope ?? null) };
  }

  @RequirePermission('units:read')
  @Get('cessions')
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UnitCessionDto[]> {
    return this.cessions.history(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('units:read')
  @Post('cession')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateUnitCessionDto,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.create({ user, unitId: id, input, meta: extractMeta(req) });
  }

  @RequirePermission('units:read')
  @Patch('cession')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateUnitCessionDto,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.update({ user, unitId: id, input, meta: extractMeta(req) });
  }

  @RequirePermission('units:read')
  @Post('cession/end')
  @HttpCode(HttpStatus.OK)
  async end(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: EndUnitCessionDto,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.end({ user, unitId: id, input, meta: extractMeta(req) });
  }

  @RequirePermission('units:read')
  @Get('cession/access/code')
  async code(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<UnitCessionCodeDto> {
    return this.cessions.accessCode(user, id, extractMeta(req));
  }

  /** Crea el acceso de una cesión que no lo tiene (con control de accesos). */
  @RequirePermission('units:read')
  @Post('cession/access')
  async createAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.createAccess(user, id, extractMeta(req));
  }

  @RequirePermission('units:read')
  @Post('cession/access/rotate')
  @HttpCode(HttpStatus.OK)
  async rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<UnitCessionCodeDto> {
    return this.cessions.rotateAccess(user, id, extractMeta(req));
  }

  @RequirePermission('units:read')
  @Post('cession/access/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.suspendAccess(user, id, extractMeta(req));
  }

  @RequirePermission('units:read')
  @Post('cession/access/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.resumeAccess(user, id, extractMeta(req));
  }
}

/** Cesiones vivas del negocio (`GET /cessions`). */
@Controller('cessions')
export class CessionsListController {
  constructor(private readonly cessions: UnitCessionsService) {}

  @RequirePermission('units:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<UnitCessionDto[]> {
    const parsed = status ? UnitCessionListStatusEnum.safeParse(status) : null;
    assertUuid(customerId);
    assertUuid(facilityId);
    return this.cessions.list(user.tenantId, {
      ...(parsed?.success ? { status: parsed.data } : {}),
      ...(customerId ? { customerId } : {}),
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }
}
