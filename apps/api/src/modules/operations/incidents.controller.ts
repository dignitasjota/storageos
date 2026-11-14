import {
  BadRequestException,
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
  Put,
} from '@nestjs/common';
import {
  CreateIncidentSchema,
  IncidentCommentSchema,
  type IncidentCommentDto,
  type IncidentContextDto,
  type IncidentDto,
  IncidentSeverityEnum,
  type IncidentSeverityValue,
  IncidentStatusEnum,
  type IncidentStatusValue,
  TransitionIncidentSchema,
  UpdateIncidentSchema,
  AddOpsFileSchema,
  IncidentCategoryEnum,
  IncidentResponseHoursSchema,
  OpsFileUploadSchema,
  type IncidentCategory,
  type IncidentReportDto,
  type IncidentResponseHours,
  type MessageAttachmentUploadDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertUuid, parsePageRequest, toPage } from '../../common/pagination';

import { IncidentsService } from './incidents.service';

import type { RequestMeta } from '../auth/auth.service';
import type { PageDto } from '@storageos/shared';
import type { Request } from 'express';

class CreateIncidentDto extends createZodDto(CreateIncidentSchema) {}
class UpdateIncidentDto extends createZodDto(UpdateIncidentSchema) {}
class TransitionIncidentDto extends createZodDto(TransitionIncidentSchema) {}
class IncidentCommentDtoBody extends createZodDto(IncidentCommentSchema) {}
class OpsFileUploadDto extends createZodDto(OpsFileUploadSchema) {}
class AddOpsFileDto extends createZodDto(AddOpsFileSchema) {}
class ResponseHoursDto extends createZodDto(IncidentResponseHoursSchema) {}

function parseCategory(value: string | undefined): IncidentCategory | undefined {
  if (!value) return undefined;
  const parsed = IncidentCategoryEnum.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_filter', message: 'Filtro no válido' });
  }
  return parsed.data;
}

/** `YYYY-MM-DD` válido o 400. */
function parseDay(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(d.getTime()) ||
    d.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequestException({ code: 'invalid_range', message: 'Fecha no válida' });
  }
  return d;
}

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
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_filter', message: 'Filtro no válido' });
  }
  return parsed.data;
}

function parseSeverity(value: string | undefined): IncidentSeverityValue | undefined {
  if (!value) return undefined;
  const parsed = IncidentSeverityEnum.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_filter', message: 'Filtro no válido' });
  }
  return parsed.data;
}

/** Los identificadores de los filtros: uno mal escrito es un 400, no un error del servidor. */
function checkIds(...ids: (string | undefined)[]): void {
  for (const id of ids) assertUuid(id);
}

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  /** Página de la lista (cursor + búsqueda) para el panel. Antes de `:id`. */
  @RequirePermission('incidents:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('facilityId') facilityId?: string,
    @Query('unitId') unitId?: string,
    @Query('customerId') customerId?: string,
    @Query('contractId') contractId?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('category') category?: string,
    @Query('responseOverdue') responseOverdue?: string,
  ): Promise<PageDto<IncidentDto>> {
    const parsedStatus = parseStatus(status);
    const parsedSeverity = parseSeverity(severity);
    const parsedCategory = parseCategory(category);
    checkIds(facilityId, unitId, customerId, contractId, assignedToUserId);
    const page = parsePageRequest(cursor, limit);
    const rows = await this.incidents.list(user.tenantId, {
      ...(search ? { search } : {}),
      page,
      ...(parsedCategory ? { category: parsedCategory } : {}),
      ...(responseOverdue === '1' || responseOverdue === 'true' ? { responseOverdue: true } : {}),
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(parsedSeverity ? { severity: parsedSeverity } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(unitId ? { unitId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(contractId ? { contractId } : {}),
      ...(assignedToUserId ? { assignedToUserId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
    return toPage(rows, page);
  }

  @RequirePermission('incidents:read')
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
    checkIds(facilityId, unitId, customerId, contractId, assignedToUserId);
    return this.incidents.list(user.tenantId, {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(parsedSeverity ? { severity: parsedSeverity } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(unitId ? { unitId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(contractId ? { contractId } : {}),
      ...(assignedToUserId ? { assignedToUserId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Plazos de la primera respuesta por gravedad (horas). Antes de `:id`. */
  @RequirePermission('incidents:read')
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<IncidentResponseHours> {
    return this.incidents.getResponseHours(user.tenantId);
  }

  @RequirePermission('incidents:manage')
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ResponseHoursDto,
  ): Promise<IncidentResponseHours> {
    return this.incidents.setResponseHours(user.tenantId, user.sub, body);
  }

  /** Informe de un periodo (por tipo, gravedad y local). Antes de `:id`. */
  @RequirePermission('incidents:read')
  @Get('report')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<IncidentReportDto> {
    const end = parseDay(to, new Date());
    const start = parseDay(from, new Date(end.getTime() - 89 * 86_400_000));
    if (start.getTime() > end.getTime()) {
      throw new BadRequestException({ code: 'invalid_range', message: 'Rango de fechas inválido' });
    }
    return this.incidents.report(
      user.tenantId,
      {
        from: start,
        to: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1)),
      },
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('incidents:write')
  @Post(':id/photos/upload-url')
  @HttpCode(HttpStatus.OK)
  photoUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OpsFileUploadDto,
  ): Promise<MessageAttachmentUploadDto> {
    return this.incidents.photoUploadUrl(
      user.tenantId,
      id,
      body.mimeType,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('incidents:write')
  @Post(':id/photos')
  addPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AddOpsFileDto,
  ): Promise<IncidentDto> {
    return this.incidents.addPhoto(user.tenantId, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('incidents:write')
  @Delete(':id/photos/:fileId')
  removePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
  ): Promise<IncidentDto> {
    return this.incidents.removePhoto(user.tenantId, id, fileId, user.facilityScope ?? null);
  }

  /** Nº de incidencias abiertas por estado — para los badges del menú. */
  @RequirePermission('incidents:read')
  @Get('pending-counts')
  async pendingCounts(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ reported: number; investigating: number }> {
    return this.incidents.countOpenByStatus(user.tenantId, user.facilityScope ?? null);
  }

  @RequirePermission('incidents:read')
  @Get(':id/context')
  context(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IncidentContextDto> {
    return this.incidents.getContext(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('incidents:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IncidentDto> {
    return this.incidents.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('incidents:write')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateIncidentDto,
    @Req() req: Request,
  ): Promise<IncidentDto> {
    return this.incidents.create({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('incidents:write')
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
      facilityScope: user.facilityScope ?? null,
      id,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('incidents:write')
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
      facilityScope: user.facilityScope ?? null,
      id,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('incidents:manage')
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
      facilityScope: user.facilityScope ?? null,
      id,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('incidents:read')
  @Get(':id/comments')
  async listComments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IncidentCommentDto[]> {
    return this.incidents.listComments(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('incidents:write')
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
      facilityScope: user.facilityScope ?? null,
      incidentId: id,
      input,
      meta: extractMeta(req),
    });
  }
}
