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
} from '@nestjs/common';
import {
  calendarDate,
  CreateLeadVisitSchema,
  UpdateLeadVisitSchema,
  type LeadFunnelReportDto,
  type LeadQuoteRecordDto,
  type LeadSummaryDto,
  type LeadTimelineItemDto,
  type LeadVisitDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { LeadInsightsService } from './lead-insights.service';
import { LeadQuotesService } from './lead-quotes.service';
import { LeadVisitsService } from './lead-visits.service';
import { listFilters } from './leads.controller';

class CreateLeadVisitDto extends createZodDto(CreateLeadVisitSchema) {}
class UpdateLeadVisitDto extends createZodDto(UpdateLeadVisitSchema) {}

const MAX_REPORT_DAYS = 731;

/**
 * Herramientas del tablero de contactos: totales por fase, informe del embudo,
 * cronología, presupuestos enviados y visitas. Se registra antes que
 * `LeadsController` para que sus rutas fijas no las capture `:id`.
 */
@Controller('leads')
export class LeadToolsController {
  constructor(
    private readonly insights: LeadInsightsService,
    private readonly quotes: LeadQuotesService,
    private readonly visits: LeadVisitsService,
  ) {}

  @Get('summary')
  @RequirePermission('leads:read')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
    @Query('facilityId') facilityId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LeadSummaryDto> {
    return this.insights.summary(
      user.tenantId,
      listFilters(user, { assignedToUserId, source, search, facilityId, from, to }),
    );
  }

  @Get('report')
  @RequirePermission('leads:read')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LeadFunnelReportDto> {
    const f = calendarDate.safeParse(from);
    const t = calendarDate.safeParse(to);
    if (!f.success || !t.success) {
      throw new BadRequestException({ code: 'invalid_date', message: 'Fechas no válidas' });
    }
    const days = (Date.parse(t.data) - Date.parse(f.data)) / 86_400_000;
    if (days < 0 || days > MAX_REPORT_DAYS) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'El periodo tiene que ir de una fecha a otra posterior, como mucho dos años',
      });
    }
    return this.insights.report(
      user.tenantId,
      { from: f.data, to: t.data },
      user.facilityScope ?? null,
    );
  }

  @Patch('visits/:visitId')
  @RequirePermission('leads:write')
  updateVisit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('visitId', new ParseUUIDPipe()) visitId: string,
    @Body() input: UpdateLeadVisitDto,
  ): Promise<LeadVisitDto> {
    return this.visits.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id: visitId,
      input,
      scope: user.facilityScope ?? null,
    });
  }

  @Delete('visits/:visitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('leads:write')
  removeVisit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('visitId', new ParseUUIDPipe()) visitId: string,
  ): Promise<void> {
    return this.visits.remove(user.tenantId, visitId, user.facilityScope ?? null);
  }

  @Get(':id/timeline')
  @RequirePermission('leads:read')
  timeline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadTimelineItemDto[]> {
    return this.insights.timeline(user.tenantId, id, user.facilityScope ?? null);
  }

  @Get(':id/quotes')
  @RequirePermission('leads:read')
  listQuotes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadQuoteRecordDto[]> {
    return this.quotes.list(user.tenantId, id, user.facilityScope ?? null);
  }

  @Get(':id/visits')
  @RequirePermission('leads:read')
  listVisits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadVisitDto[]> {
    return this.visits.list(user.tenantId, id, user.facilityScope ?? null);
  }

  @Post(':id/visits')
  @RequirePermission('leads:write')
  createVisit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateLeadVisitDto,
  ): Promise<LeadVisitDto> {
    return this.visits.create({
      tenantId: user.tenantId,
      userId: user.sub,
      leadId: id,
      input,
      scope: user.facilityScope ?? null,
    });
  }
}
