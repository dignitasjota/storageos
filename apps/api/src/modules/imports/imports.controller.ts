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
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ContractsImportService } from './contracts-import.service';
import { resolveImportCsv } from './import-engine';
import { ImportsService } from './imports.service';
import { UnitsImportService } from './units-import.service';

import type { RequestMeta } from '../auth/auth.service';
import type { ImportFormat } from '@storageos/shared';
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

  @RequirePermission('imports:manage')
  @Post('customers/preview')
  async previewCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportPreviewBody,
  ): Promise<ImportPreviewDto> {
    const csv = await resolveImportCsv(body.csv, body.format as ImportFormat);
    return this.imports.previewCustomers(user.tenantId, csv);
  }

  @RequirePermission('imports:manage')
  @Post('customers/commit')
  async commitCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCommitBody,
    @Req() req: Request,
  ): Promise<ImportCommitDto> {
    const csv = await resolveImportCsv(body.csv, body.format as ImportFormat);
    return this.imports.commitCustomers({
      tenantId: user.tenantId,
      userId: user.sub,
      meta: extractMeta(req),
      csv,
      onDuplicate: body.onDuplicate,
    });
  }

  // ------------------------------ Trasteros --------------------------------

  @Get('units/template')
  unitsTemplate(): { csv: string } {
    return { csv: this.unitsImport.template() };
  }

  @RequirePermission('imports:manage')
  @Post('units/preview')
  async previewUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportPreviewBody,
  ): Promise<ImportPreviewDto> {
    const csv = await resolveImportCsv(body.csv, body.format as ImportFormat);
    return this.unitsImport.preview(user.tenantId, csv);
  }

  @RequirePermission('imports:manage')
  @Post('units/commit')
  async commitUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCommitBody,
    @Req() req: Request,
  ): Promise<ImportCommitDto> {
    const csv = await resolveImportCsv(body.csv, body.format as ImportFormat);
    return this.unitsImport.commit({
      tenantId: user.tenantId,
      userId: user.sub,
      meta: extractMeta(req),
      csv,
      onDuplicate: body.onDuplicate,
    });
  }

  // ------------------------------ Contratos --------------------------------

  @Get('contracts/template')
  contractsTemplate(): { csv: string } {
    return { csv: this.contractsImport.template() };
  }

  @RequirePermission('imports:manage')
  @Post('contracts/preview')
  async previewContracts(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportPreviewBody,
  ): Promise<ImportPreviewDto> {
    const csv = await resolveImportCsv(body.csv, body.format as ImportFormat);
    return this.contractsImport.preview(user.tenantId, csv);
  }

  @RequirePermission('imports:manage')
  @Post('contracts/commit')
  async commitContracts(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCommitBody,
    @Req() req: Request,
  ): Promise<ImportCommitDto> {
    const csv = await resolveImportCsv(body.csv, body.format as ImportFormat);
    return this.contractsImport.commit({
      tenantId: user.tenantId,
      userId: user.sub,
      meta: extractMeta(req),
      csv,
      onDuplicate: body.onDuplicate,
    });
  }
}
