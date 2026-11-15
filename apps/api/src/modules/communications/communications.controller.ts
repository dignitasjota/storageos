import {
  Body,
  Controller,
  Get,
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
  CommunicationStatusEnum,
  type CommunicationStatusValue,
  SendCommunicationSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CommunicationsService, type ListFilters } from './communications.service';

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
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('leadId') leadId?: string,
    @Query('source') source?: string,
  ): Promise<CommunicationPageDto> {
    for (const [key, value] of [
      ['cursor', cursor],
      ['customerId', customerId],
      ['leadId', leadId],
    ] as const) {
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
    const fromDate = date('from', from);
    const toDate = date('to', to);
    const take = Number(limit);
    return this.service.listPage(user.tenantId, {
      scope: user.facilityScope ?? null,
      ...(cursor ? { cursor } : {}),
      ...(limit && Number.isFinite(take) ? { limit: Math.trunc(take) } : {}),
      ...(search ? { search } : {}),
      ...(fromDate ? { from: fromDate } : {}),
      ...(toDate ? { to: toDate } : {}),
      ...(channel ? { channel: parseChannel(channel) } : {}),
      ...(status ? { status: parseStatus(status) } : {}),
      ...(customerId ? { customerId } : {}),
      ...(leadId ? { leadId } : {}),
      ...(source ? { source } : {}),
    });
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
