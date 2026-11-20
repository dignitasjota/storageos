import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CreateReportScheduleSchema,
  type ReportGeneratorCatalogEntry,
  PreviewReportSchema,
  type ReportScheduleDto,
  UpdateReportScheduleSchema,
  type ReportPreviewDto,
  type ReportRunDto,
  RunReportSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ReportSchedulesService } from './report-schedules.service';
import { ReportsService } from './reports.service';

class RunReportDto extends createZodDto(RunReportSchema) {}
class PreviewReportDto extends createZodDto(PreviewReportSchema) {}
class CreateReportScheduleDto extends createZodDto(CreateReportScheduleSchema) {}
class UpdateReportScheduleDto extends createZodDto(UpdateReportScheduleSchema) {}

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly service: ReportsService,
    private readonly schedules: ReportSchedulesService,
  ) {}

  // ─── Envíos por correo (antes de `:id`) ─────────────────────────────────────

  @RequirePermission('reports:read')
  @Get('schedules')
  listSchedules(@CurrentUser() user: AuthenticatedUser): Promise<ReportScheduleDto[]> {
    return this.schedules.list(user);
  }

  @RequirePermission('reports:run')
  @Post('schedules')
  createSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateReportScheduleDto,
  ): Promise<ReportScheduleDto> {
    return this.schedules.create(user, body);
  }

  @RequirePermission('reports:run')
  @Patch('schedules/:id')
  updateSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateReportScheduleDto,
  ): Promise<ReportScheduleDto> {
    return this.schedules.update(user, id, body);
  }

  @RequirePermission('reports:run')
  @Delete('schedules/:id')
  @HttpCode(204)
  removeSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.schedules.remove(user, id);
  }

  /** Lo envía ya, sin cambiar el próximo envío (5 por minuto). */
  @RequirePermission('reports:run')
  @Post('schedules/:id/send')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sendSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReportScheduleDto> {
    return this.schedules.sendNow(user, id);
  }

  @RequirePermission('reports:read')
  @Get('catalog')
  catalog(@CurrentUser() user: AuthenticatedUser): Promise<ReportGeneratorCatalogEntry[]> {
    return this.service.catalog(user);
  }

  @RequirePermission('reports:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ReportRunDto[]> {
    return this.service.list(user);
  }

  @RequirePermission('reports:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReportRunDto> {
    return this.service.detail(user, id);
  }

  /** URL firmada de corta duración para descargar el fichero (bucket privado). */
  @RequirePermission('reports:read')
  @Get(':id/download')
  download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ url: string }> {
    return this.service.getSignedDownloadUrl(user, id);
  }

  /** Cada informe abre un navegador sin cabeza: 10 por minuto sobran. */
  @Post('run')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('reports:run')
  run(@CurrentUser() user: AuthenticatedUser, @Body() body: RunReportDto): Promise<ReportRunDto> {
    return this.service.run({ user, input: body });
  }

  /** Primeras filas y totales del informe, sin guardarlo (20 por minuto). */
  @Post('preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('reports:run')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewReportDto,
  ): Promise<ReportPreviewDto> {
    return this.service.preview(user, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('reports:run')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.service.remove(user, id);
  }
}
