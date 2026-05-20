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
import { Roles } from '../../common/decorators/roles.decorator';

import { ReportsService } from './reports.service';

class RunReportDto extends createZodDto(RunReportSchema) {}

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('catalog')
  catalog(): ReportGeneratorCatalogEntry[] {
    return this.service.catalog();
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ReportRunDto[]> {
    return this.service.list(user.tenantId);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReportRunDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post('run')
  @Roles('owner', 'manager')
  run(@CurrentUser() user: AuthenticatedUser, @Body() body: RunReportDto): Promise<ReportRunDto> {
    return this.service.run({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
    });
  }
}
