import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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
  catalog(): ReportGeneratorCatalogEntry[] {
    return this.service.catalog();
  }

  @RequirePermission('reports:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ReportRunDto[]> {
    return this.service.list(user.tenantId);
  }

  @RequirePermission('reports:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReportRunDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post('run')
  @RequirePermission('reports:run')
  run(@CurrentUser() user: AuthenticatedUser, @Body() body: RunReportDto): Promise<ReportRunDto> {
    return this.service.run({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
    });
  }
}
