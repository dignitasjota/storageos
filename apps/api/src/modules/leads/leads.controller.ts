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
} from '@nestjs/common';
import {
  ConvertLeadSchema,
  CreateLeadSchema,
  type CommunicationDto,
  type LeadDto,
  LeadStatusEnum,
  type LeadStatusValue,
  LeadReplySchema,
  LeadQuoteSchema,
  type LeadQuoteDto as LeadQuoteResultDto,
  SendLeadQuoteSchema,
  type SendLeadQuoteResultDto,
  SetLeadMarketingSchema,
  TransitionLeadSchema,
  UpdateLeadSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { parsePageRequest, toPage } from '../../common/pagination';

import { LeadQuotesService } from './lead-quotes.service';
import { LeadsService } from './leads.service';

import type { RequestMeta } from '../auth/auth.service';
import type { PageDto } from '@storageos/shared';
import type { Request } from 'express';

class CreateLeadDto extends createZodDto(CreateLeadSchema) {}
class UpdateLeadDto extends createZodDto(UpdateLeadSchema) {}
class TransitionLeadDto extends createZodDto(TransitionLeadSchema) {}
class SetLeadMarketingDto extends createZodDto(SetLeadMarketingSchema) {}
class LeadReplyDto extends createZodDto(LeadReplySchema) {}
class ConvertLeadDto extends createZodDto(ConvertLeadSchema) {}
class LeadQuoteDto extends createZodDto(LeadQuoteSchema) {}
class SendLeadQuoteDto extends createZodDto(SendLeadQuoteSchema) {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filtros de la lista: un valor que no existe da 400 (antes, 500). */
function listFilters(
  user: AuthenticatedUser,
  q: {
    status?: string | undefined;
    assignedToUserId?: string | undefined;
    source?: string | undefined;
    search?: string | undefined;
  },
) {
  if (q.status && !LeadStatusEnum.safeParse(q.status).success) {
    throw new BadRequestException({ code: 'invalid_status', message: 'Fase no válida' });
  }
  let assigned: string | null | undefined;
  if (q.assignedToUserId === 'me') assigned = user.sub;
  else if (q.assignedToUserId === 'none') assigned = null;
  else if (q.assignedToUserId) {
    if (!UUID.test(q.assignedToUserId)) {
      throw new BadRequestException({ code: 'invalid_user', message: 'Responsable no válido' });
    }
    assigned = q.assignedToUserId;
  }
  return {
    scope: user.facilityScope ?? null,
    ...(q.status ? { status: q.status as LeadStatusValue } : {}),
    ...(assigned !== undefined ? { assignedToUserId: assigned } : {}),
    ...(q.source ? { source: q.source.slice(0, 60) } : {}),
    ...(q.search ? { search: q.search.slice(0, 120) } : {}),
  };
}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly service: LeadsService,
    private readonly quotes: LeadQuotesService,
  ) {}

  /** Página de la lista (cursor + búsqueda) para el panel. Antes de `:id`. */
  @Get('page')
  @RequirePermission('leads:read')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageDto<LeadDto>> {
    const page = parsePageRequest(cursor, limit);
    const rows = await this.service.list(user.tenantId, {
      page,
      ...listFilters(user, { status, assignedToUserId, source, search }),
    });
    return toPage(rows, page);
  }

  @Get()
  @RequirePermission('leads:read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
  ): Promise<LeadDto[]> {
    return this.service.list(
      user.tenantId,
      listFilters(user, { status, assignedToUserId, source, search }),
    );
  }

  /** Orígenes disponibles (sugeridos + los que el tenant ya usó). Antes de `:id`. */
  @Get('sources')
  @RequirePermission('leads:read')
  sources(@CurrentUser() user: AuthenticatedUser): Promise<{ value: string; label: string }[]> {
    return this.service.listSources(user.tenantId);
  }

  @Get(':id')
  @RequirePermission('leads:read')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadDto> {
    return this.service.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  @Post()
  @RequirePermission('leads:write')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
      scope: user.facilityScope ?? null,
    });
  }

  @Patch(':id')
  @RequirePermission('leads:write')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
      scope: user.facilityScope ?? null,
    });
  }

  /** Presupuesto (sin enviar): lo que pagaría y el texto del correo. */
  @Post(':id/quote/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('leads:read')
  quotePreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: LeadQuoteDto,
  ): Promise<LeadQuoteResultDto> {
    return this.quotes.preview(user.tenantId, id, body, user.facilityScope ?? null);
  }

  /** Envía el presupuesto por correo con el enlace a la reserva ya rellenada. */
  @Post(':id/quote/send')
  @RequirePermission('communications:send')
  quoteSend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendLeadQuoteDto,
    @Req() req: Request,
  ): Promise<SendLeadQuoteResultDto> {
    return this.quotes.send(
      user.tenantId,
      user.sub,
      id,
      body,
      { ipAddress: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null },
      user.facilityScope ?? null,
    );
  }

  /** Responde al contacto por email (queda en Comunicaciones). */
  @Post(':id/reply')
  @RequirePermission('communications:send')
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: LeadReplyDto,
    @Req() req: Request,
  ): Promise<CommunicationDto> {
    return this.service.reply({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
      scope: user.facilityScope ?? null,
    });
  }

  /** Consentimiento comercial del lead (true = lo da; false = se da de baja). */
  @Post(':id/marketing')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('leads:write')
  setMarketing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetLeadMarketingDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.setMarketing({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      consent: body.consent,
      meta: extractMeta(req),
      scope: user.facilityScope ?? null,
    });
  }

  @Post(':id/transition')
  @RequirePermission('leads:write')
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TransitionLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.transition({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
      scope: user.facilityScope ?? null,
    });
  }

  @Post(':id/convert')
  @RequirePermission('leads:write')
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ConvertLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.convert({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Delete(':id')
  @RequirePermission('leads:manage')
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
      scope: user.facilityScope ?? null,
    });
  }
}
