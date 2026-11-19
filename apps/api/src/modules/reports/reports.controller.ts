import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type ReportGeneratorCatalogEntry,
  type ReportRunDto,
  RunReportSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ReportsService } from './reports.service';

class RunReportDto extends createZodDto(RunReportSchema) {}

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

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
