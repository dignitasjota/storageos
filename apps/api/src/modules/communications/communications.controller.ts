import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  BadRequestException,
} from '@nestjs/common';
import {
  CommunicationChannelEnum,
  type CommunicationChannelValue,
  type CommunicationDto,
  type CommunicationPageDto,
  type CommunicationStatsDto,
  CommunicationStatusEnum,
  isCommunicationSourceGroup,
  type ProblemAddressDto,
  type CommunicationStatusValue,
  SendCommunicationSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import {
  CommunicationsService,
  type ListFilters,
  type PageFilters,
} from './communications.service';

class SendCommunicationDto extends createZodDto(SendCommunicationSchema) {}

@Controller('communications')
export class CommunicationsController {
  constructor(private readonly service: CommunicationsService) {}

  @RequirePermission('communications:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('leadId') leadId?: string,
    @Query('source') source?: string,
    @Query('contractId') contractId?: string,
    @Query('invoiceId') invoiceId?: string,
  ): Promise<CommunicationDto[]> {
    const filters: ListFilters = { scope: user.facilityScope ?? null };
    if (channel) filters.channel = parseChannel(channel);
    if (status) filters.status = parseStatus(status);
    if (source) filters.source = source;
    // Un id mal formado daría un 500 de Prisma (columna UUID): se valida aquí.
    for (const [key, value] of [
      ['customerId', customerId],
      ['leadId', leadId],
      ['contractId', contractId],
      ['invoiceId', invoiceId],
    ] as const) {
      if (!value) continue;
      if (!UUID_RE.test(value)) {
        throw new BadRequestException({ code: 'invalid_id', message: `${key} no es un UUID` });
      }
      filters[key] = value;
    }
    return this.service.list(user.tenantId, filters);
  }

  /** Historial paginado por cursor, con búsqueda y rango de fechas. */
  @RequirePermission('communications:read')
  @Get('page')
  page(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: PageQuery,
  ): Promise<CommunicationPageDto> {
    return this.service.listPage(user.tenantId, pageFilters(user, q));
  }

  /** Cifras del historial con los mismos filtros. */
  @RequirePermission('communications:read')
  @Get('stats')
  stats(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: PageQuery,
  ): Promise<CommunicationStatsDto> {
    return this.service.stats(user.tenantId, pageFilters(user, q));
  }

  /** El historial con estos filtros en CSV (hasta 5.000 envíos). */
  @RequirePermission('communications:read')
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="comunicaciones.csv"')
  exportCsv(@CurrentUser() user: AuthenticatedUser, @Query() q: PageQuery): Promise<string> {
    return this.service.exportCsv(user.tenantId, pageFilters(user, q));
  }

  /** Inquilinos y contactos a los que no les llegan los correos. */
  @RequirePermission('communications:read')
  @Get('problem-addresses')
  problemAddresses(@CurrentUser() user: AuthenticatedUser): Promise<ProblemAddressDto[]> {
    return this.service.problemAddresses(user.tenantId, user.facilityScope ?? null);
  }

  /** Canales que pueden enviar ahora mismo (para habilitar opciones en la UI). */
  @RequirePermission('communications:read')
  @Get('channels')
  channels(): { email: boolean; whatsapp: boolean } {
    return { email: true, whatsapp: this.service.whatsappAvailable };
  }

  @RequirePermission('communications:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CommunicationDto> {
    return this.service.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Cómo le llegó el correo (HTML con la marca del negocio). */
  @RequirePermission('communications:read')
  @Get(':id/preview')
  async preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ html: string }> {
    return { html: await this.service.previewHtml(user.tenantId, id, user.facilityScope ?? null) };
  }

  /** Cancela un envío que aún no ha salido. */
  @Post(':id/cancel')
  @RequirePermission('communications:send')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CommunicationDto> {
    return this.service.cancel(user.tenantId, id, user.facilityScope ?? null, user.sub);
  }

  @Post()
  @RequirePermission('communications:send')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendCommunicationDto,
  ): Promise<CommunicationDto> {
    return this.service.sendManual({ tenantId: user.tenantId, input: body });
  }

  @Post(':id/retry')
  @RequirePermission('communications:send')
  @HttpCode(HttpStatus.OK)
  retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CommunicationDto> {
    return this.service.retry(user.tenantId, id, user.facilityScope ?? null);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseChannel(value: string): CommunicationChannelValue {
  const r = CommunicationChannelEnum.safeParse(value);
  if (!r.success) {
    throw new BadRequestException({ code: 'invalid_channel', message: 'Canal no válido' });
  }
  return r.data;
}

function parseStatus(value: string): CommunicationStatusValue {
  const r = CommunicationStatusEnum.safeParse(value);
  if (!r.success) {
    throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
  }
  return r.data;
}

interface PageQuery {
  cursor?: string;
  limit?: string;
  search?: string;
  from?: string;
  to?: string;
  channel?: string;
  status?: string;
  customerId?: string;
  leadId?: string;
  facilityId?: string;
  source?: string;
  sourceGroup?: string;
}

/** Filtros del historial a partir de la URL (validados: un id o fecha malos dan 400). */
function pageFilters(user: AuthenticatedUser, q: PageQuery): PageFilters {
  for (const key of ['cursor', 'customerId', 'leadId', 'facilityId'] as const) {
    const value = q[key];
    if (value && !UUID_RE.test(value)) {
      throw new BadRequestException({ code: 'invalid_id', message: `${key} no es un UUID` });
    }
  }
  const date = (key: string, v?: string): Date | undefined => {
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException({ code: 'invalid_date', message: `${key} no es una fecha` });
    }
    return d;
  };
  if (q.sourceGroup && !isCommunicationSourceGroup(q.sourceGroup)) {
    throw new BadRequestException({ code: 'invalid_source_group', message: 'Tipo no válido' });
  }
  const fromDate = date('from', q.from);
  const toDate = date('to', q.to);
  const take = Number(q.limit);
  return {
    scope: user.facilityScope ?? null,
    ...(q.cursor ? { cursor: q.cursor } : {}),
    ...(q.limit && Number.isFinite(take) ? { limit: Math.trunc(take) } : {}),
    ...(q.search ? { search: q.search } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
    ...(q.channel ? { channel: parseChannel(q.channel) } : {}),
    ...(q.status ? { status: parseStatus(q.status) } : {}),
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.leadId ? { leadId: q.leadId } : {}),
    ...(q.facilityId ? { facilityId: q.facilityId } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.sourceGroup && isCommunicationSourceGroup(q.sourceGroup)
      ? { sourceGroup: q.sourceGroup }
      : {}),
  };
}
