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
  type AccessCredentialDto,
  type NightPassListDto,
  type AccessCredentialStatusValue,
  type AccessCredentialWithSecretDto,
  AccessCredentialStatusEnum,
  AccessMethodEnum,
  type AccessMethodValue,
  CreateCredentialSchema,
  CreateFacialCredentialSchema,
  RotateCredentialSchema,
  SuspendCredentialSchema,
  UpdateCredentialSchema,
  MAX_PAGE_SIZE,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { parsePageRequest, toPage } from '../../common/pagination';

import { AccessCredentialsService } from './access-credentials.service';

import type { RequestMeta } from '../auth/auth.service';
import type { PageDto } from '@storageos/shared';
import type { Request } from 'express';

class CreateCredentialDto extends createZodDto(CreateCredentialSchema) {}
class CreateFacialCredentialDto extends createZodDto(CreateFacialCredentialSchema) {}
class UpdateCredentialDto extends createZodDto(UpdateCredentialSchema) {}
class RotateCredentialDto extends createZodDto(RotateCredentialSchema) {}
class SuspendCredentialDto extends createZodDto(SuspendCredentialSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

function parseStatus(value: string | undefined): AccessCredentialStatusValue | undefined {
  if (!value) return undefined;
  const parsed = AccessCredentialStatusEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseMethod(value: string | undefined): AccessMethodValue | undefined {
  if (!value) return undefined;
  const parsed = AccessMethodEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

@Controller('access/credentials')
@RequireFeature('access_control')
export class AccessCredentialsController {
  constructor(private readonly service: AccessCredentialsService) {}

  @RequirePermission('access:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('method') method?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<AccessCredentialDto[]> {
    const parsedStatus = parseStatus(status);
    const parsedMethod = parseMethod(method);
    return this.service.list(user.tenantId, {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(customerId ? { customerId } : {}),
      ...(parsedMethod ? { method: parsedMethod } : {}),
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
      page: { limit: MAX_PAGE_SIZE },
    });
  }

  /** La lista por páginas, con búsqueda por inquilino. Antes de `:id`. */
  @RequirePermission('access:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('method') method?: string,
    @Query('facilityId') facilityId?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageDto<AccessCredentialDto>> {
    const parsedStatus = parseStatus(status);
    const parsedMethod = parseMethod(method);
    const page = parsePageRequest(cursor, limit);
    const rows = await this.service.list(user.tenantId, {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(customerId ? { customerId } : {}),
      ...(parsedMethod ? { method: parsedMethod } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(search ? { search } : {}),
      facilityScope: user.facilityScope ?? null,
      page,
    });
    return toPage(rows, page);
  }

  /** Pases nocturnos del tenant (subpágina de accesos) + ingresos. */
  @RequirePermission('access:read')
  @Get('night-passes')
  nightPasses(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<NightPassListDto> {
    return this.service.listNightPasses(user.tenantId, user.facilityScope ?? null, facilityId);
  }

  @RequirePermission('access:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AccessCredentialDto> {
    return this.service.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  @Post()
  @RequirePermission('access:manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialWithSecretDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /**
   * Alta de credencial FACIAL. Gateada por la feature `facial_access` (add-on),
   * que **sustituye** al `access_control` de la clase (FeatureGuard resuelve
   * override método > clase) → sin el add-on facial → 403 aunque tenga accesos.
   */
  @Post('face')
  @RequireFeature('facial_access')
  @RequirePermission('access:manage')
  createFacial(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateFacialCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    return this.service.createFacial({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Patch(':id')
  @RequirePermission('access:manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Post(':id/rotate')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RotateCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialWithSecretDto> {
    return this.service.rotate({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Post(':id/suspend')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SuspendCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    const [row] = await this.service.suspend({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
    return row!;
  }

  @Post(':id/resume')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  async resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    const [row] = await this.service.resume({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
    return row!;
  }

  @Post(':id/revoke')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    return this.service.revoke({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }
}
