import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  type ImportCommitDto,
  ImportCommitSchema,
  type ImportPreviewDto,
  ImportPreviewSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { ContractsImportService } from './contracts-import.service';
import { ImportsService } from './imports.service';
import { UnitsImportService } from './units-import.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class ImportPreviewBody extends createZodDto(ImportPreviewSchema) {}
class ImportCommitBody extends createZodDto(ImportCommitSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly unitsImport: UnitsImportService,
    private readonly contractsImport: ContractsImportService,
  ) {}

  // ----------------------------- Inquilinos --------------------------------

  @Get('customers/template')
  customersTemplate(): { csv: string } {
    return { csv: this.imports.customersTemplate() };
  }

  @Roles('owner', 'manager')
  @Post('customers/preview')
  previewCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportPreviewBody,
  ): Promise<ImportPreviewDto> {
    return this.imports.previewCustomers(user.tenantId, body.csv);
  }

  @Roles('owner', 'manager')
  @Post('customers/commit')
  commitCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCommitBody,
    @Req() req: Request,
  ): Promise<ImportCommitDto> {
    return this.imports.commitCustomers({
      tenantId: user.tenantId,
      userId: user.sub,
      meta: extractMeta(req),
      csv: body.csv,
      onDuplicate: body.onDuplicate,
    });
  }

  // ------------------------------ Trasteros --------------------------------

  @Get('units/template')
  unitsTemplate(): { csv: string } {
    return { csv: this.unitsImport.template() };
  }

  @Roles('owner', 'manager')
  @Post('units/preview')
  previewUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportPreviewBody,
  ): Promise<ImportPreviewDto> {
    return this.unitsImport.preview(user.tenantId, body.csv);
  }

  @Roles('owner', 'manager')
  @Post('units/commit')
  commitUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCommitBody,
    @Req() req: Request,
  ): Promise<ImportCommitDto> {
    return this.unitsImport.commit({
      tenantId: user.tenantId,
      userId: user.sub,
      meta: extractMeta(req),
      csv: body.csv,
      onDuplicate: body.onDuplicate,
    });
  }

  // ------------------------------ Contratos --------------------------------

  @Get('contracts/template')
  contractsTemplate(): { csv: string } {
    return { csv: this.contractsImport.template() };
  }

  @Roles('owner', 'manager')
  @Post('contracts/preview')
  previewContracts(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportPreviewBody,
  ): Promise<ImportPreviewDto> {
    return this.contractsImport.preview(user.tenantId, body.csv);
  }

  @Roles('owner', 'manager')
  @Post('contracts/commit')
  commitContracts(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCommitBody,
    @Req() req: Request,
  ): Promise<ImportCommitDto> {
    return this.contractsImport.commit({
      tenantId: user.tenantId,
      userId: user.sub,
      meta: extractMeta(req),
      csv: body.csv,
      onDuplicate: body.onDuplicate,
    });
  }
}
