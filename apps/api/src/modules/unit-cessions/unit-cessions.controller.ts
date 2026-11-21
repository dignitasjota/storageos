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
  CreateUnitCessionCodeSchema,
  CreateUnitCessionSchema,
  EndUnitCessionSchema,
  type PageDto,
  SnoozeUnitCessionSchema,
  type UnitCessionCodeDto,
  type UnitCessionDto,
  UnitCessionListStatusEnum,
  type UnitCessionNewCodeDto,
  type UnitCessionToContractDto,
  UpdateUnitCessionCodeSchema,
  UpdateUnitCessionSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertUuid, parsePageRequest } from '../../common/pagination';

import { UnitCessionsService } from './unit-cessions.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateUnitCessionDto extends createZodDto(CreateUnitCessionSchema) {}
class UpdateUnitCessionDto extends createZodDto(UpdateUnitCessionSchema) {}
class EndUnitCessionDto extends createZodDto(EndUnitCessionSchema) {}
class SnoozeUnitCessionDto extends createZodDto(SnoozeUnitCessionSchema) {}
class CreateUnitCessionCodeDto extends createZodDto(CreateUnitCessionCodeSchema) {}
class UpdateUnitCessionCodeDto extends createZodDto(UpdateUnitCessionCodeSchema) {}

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

  /**
   * Pasa la cesión a contrato: la termina dejando el trastero disponible (sin
   * avisar a la lista de espera) y devuelve el asistente con él ya elegido.
   */
  @RequirePermission('units:read')
  @Post('cession/to-contract')
  @HttpCode(HttpStatus.OK)
  async toContract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<UnitCessionToContractDto> {
    return this.cessions.toContract({ user, unitId: id, meta: extractMeta(req) });
  }

  /** Pospone 7 o 30 días el aviso de una cesión vencida. */
  @RequirePermission('units:read')
  @Post('cession/snooze')
  @HttpCode(HttpStatus.OK)
  async snooze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SnoozeUnitCessionDto,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.snooze({ user, unitId: id, input, meta: extractMeta(req) });
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

  /** Acceso 24 h y nombre del código principal. */
  @RequirePermission('units:read')
  @Patch('cession/access')
  async updatePrimary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateUnitCessionCodeDto,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.updateCode(user, id, undefined, input, extractMeta(req));
  }

  // --- Varios códigos por cesión (`credentialId` de un código de la cesión).

  /** Otro código para la misma cesión (p. ej. para su pareja). */
  @RequirePermission('units:read')
  @Post('cession/access/codes')
  async createCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateUnitCessionCodeDto,
    @Req() req: Request,
  ): Promise<UnitCessionNewCodeDto> {
    return this.cessions.createCode(user, id, input, extractMeta(req));
  }

  @RequirePermission('units:read')
  @Get('cession/access/codes/:credentialId/code')
  async codeOf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: Request,
  ): Promise<UnitCessionCodeDto> {
    return this.cessions.accessCode(user, id, extractMeta(req), credentialId);
  }

  @RequirePermission('units:read')
  @Patch('cession/access/codes/:credentialId')
  async updateCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Body() input: UpdateUnitCessionCodeDto,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.updateCode(user, id, credentialId, input, extractMeta(req));
  }

  @RequirePermission('units:read')
  @Post('cession/access/codes/:credentialId/rotate')
  @HttpCode(HttpStatus.OK)
  async rotateCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: Request,
  ): Promise<UnitCessionCodeDto> {
    return this.cessions.rotateAccess(user, id, extractMeta(req), credentialId);
  }

  @RequirePermission('units:read')
  @Post('cession/access/codes/:credentialId/suspend')
  @HttpCode(HttpStatus.OK)
  async suspendCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.suspendAccess(user, id, extractMeta(req), credentialId);
  }

  @RequirePermission('units:read')
  @Post('cession/access/codes/:credentialId/resume')
  @HttpCode(HttpStatus.OK)
  async resumeCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.resumeAccess(user, id, extractMeta(req), credentialId);
  }

  /** Quita un código que no es el principal. */
  @RequirePermission('units:read')
  @Delete('cession/access/codes/:credentialId')
  async removeCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: Request,
  ): Promise<UnitCessionDto> {
    return this.cessions.removeCode(user, id, credentialId, extractMeta(req));
  }
}

/** Cesiones del negocio (`GET /cessions`, `GET /cessions/page`). */
@Controller('cessions')
export class CessionsListController {
  constructor(private readonly cessions: UnitCessionsService) {}

  /** Página «Cesiones»: por estado, local y persona o trastero, por cursor. */
  @RequirePermission('units:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('facilityId') facilityId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageDto<UnitCessionDto>> {
    const parsed = status ? UnitCessionListStatusEnum.safeParse(status) : null;
    assertUuid(facilityId);
    return this.cessions.page(user.tenantId, {
      status: parsed?.success ? parsed.data : 'active',
      ...(search?.trim() ? { search: search.trim().slice(0, 120) } : {}),
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
      page: parsePageRequest(cursor, limit),
    });
  }

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
