import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ACCOUNTANT_DEPOSIT_COLUMNS,
  ACCOUNTANT_EXPENSE_COLUMNS,
  ACCOUNTANT_INVOICE_COLUMNS,
  ACCOUNTANT_PAYMENT_COLUMNS,
  AccountantExportQuerySchema,
  CloseFiscalQuarterSchema,
  ReopenFiscalQuarterSchema,
  SendAccountantReportSchema,
  UpdateAccountantSettingsSchema,
  toAccountantCsv,
  withoutActivity,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AccountantExportService } from '../billing-saas/accountant-export.service';

import { AccountantReportService } from './accountant-report.service';
import { FiscalPeriodsService } from './fiscal-periods.service';
import { FiscalService } from './fiscal.service';

import type {
  AccountantSendResultDto,
  AccountantSettingsDto,
  AccountingExportDto,
  FiscalChecksDto,
  FiscalClosureDto,
  Model303Dto,
  Model347Dto,
  ReceivedInvoicesBookDto,
  VatBookDto,
  WithholdingsDto,
} from '@storageos/shared';
import type { Request, Response } from 'express';

class CloseFiscalQuarterDto extends createZodDto(CloseFiscalQuarterSchema) {}
class ReopenFiscalQuarterDto extends createZodDto(ReopenFiscalQuarterSchema) {}
class UpdateAccountantSettingsDto extends createZodDto(UpdateAccountantSettingsSchema) {}
class SendAccountantReportDto extends createZodDto(SendAccountantReportSchema) {}

const metaOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

function parseYear(raw: string | undefined): number {
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new BadRequestException({ code: 'invalid_year', message: 'Año no válido' });
  }
  return y;
}

function parseQuarter(raw: string | undefined): number {
  const q = Number(raw);
  if (!Number.isInteger(q) || q < 1 || q > 4) {
    throw new BadRequestException({
      code: 'invalid_quarter',
      message: 'Trimestre no válido (1-4)',
    });
  }
  return q;
}

/**
 * Los libros y modelos son de toda la empresa: quien solo ve unos locales no
 * los ve (como la conciliación bancaria y las remesas).
 */
function assertAllFacilities(user: AuthenticatedUser): void {
  if (user.facilityScope && user.facilityScope.length > 0) {
    throw new ForbiddenException({
      code: 'fiscal_requires_all_facilities',
      message:
        'La fiscalidad es de toda la empresa: solo la ve quien tiene acceso a todos los locales',
    });
  }
}

@RequirePermission('invoices:manage')
@Controller('fiscal')
export class FiscalController {
  constructor(
    private readonly fiscal: FiscalService,
    private readonly accountant: AccountantExportService,
    private readonly periods: FiscalPeriodsService,
    private readonly reports: AccountantReportService,
  ) {}

  /** Libro registro de facturas recibidas (gastos desglosados). */
  @Get('received-book')
  receivedBook(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<ReceivedInvoicesBookDto> {
    assertAllFacilities(user);
    if (!from || !to) {
      throw new BadRequestException({ code: 'range_required', message: 'Indica from y to' });
    }
    return this.fiscal.receivedBook(user.tenantId, from, to, parseOwner(ownerId));
  }

  /** Retenciones del trimestre: 111, 115 y las que te practican. */
  @Get('withholdings')
  withholdings(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('quarter') quarter: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<WithholdingsDto> {
    assertAllFacilities(user);
    return this.fiscal.withholdings(
      user.tenantId,
      parseYear(year),
      parseQuarter(quarter),
      parseOwner(ownerId),
    );
  }

  /** «Antes de presentar»: avisos del trimestre y su cierre, si lo hay. */
  @Get('checks')
  checks(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('quarter') quarter: string,
  ): Promise<FiscalChecksDto> {
    assertAllFacilities(user);
    return this.periods.checks(user.tenantId, parseYear(year), parseQuarter(quarter));
  }

  @Get('closures')
  closures(@CurrentUser() user: AuthenticatedUser): Promise<FiscalClosureDto[]> {
    assertAllFacilities(user);
    return this.periods.list(user.tenantId);
  }

  @Post('closures')
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CloseFiscalQuarterDto,
    @Req() req: Request,
  ): Promise<FiscalClosureDto> {
    assertAllFacilities(user);
    return this.periods.close(user.tenantId, user.sub, body.year, body.quarter, metaOf(req));
  }

  /** Reabrir un trimestre: solo el propietario. */
  @Post('closures/:id/reopen')
  @HttpCode(200)
  @RequirePermission('billing:configure')
  reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReopenFiscalQuarterDto,
    @Req() req: Request,
  ): Promise<FiscalClosureDto> {
    assertAllFacilities(user);
    return this.periods.reopen(user.tenantId, user.sub, id, body.reason, metaOf(req));
  }

  @Get('accountant')
  accountantSettings(@CurrentUser() user: AuthenticatedUser): Promise<AccountantSettingsDto> {
    assertAllFacilities(user);
    return this.reports.getSettings(user.tenantId);
  }

  @Put('accountant')
  updateAccountantSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateAccountantSettingsDto,
    @Req() req: Request,
  ): Promise<AccountantSettingsDto> {
    assertAllFacilities(user);
    return this.reports.updateSettings(user.tenantId, user.sub, body, metaOf(req));
  }

  /** Envía ahora a la asesoría el Excel de un periodo. */
  @Post('accountant/send')
  @HttpCode(200)
  sendToAccountant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendAccountantReportDto,
  ): Promise<AccountantSendResultDto> {
    assertAllFacilities(user);
    if (body.from > body.to) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'Rango de fechas no válido',
      });
    }
    return this.reports.send(user.tenantId, body.from, body.to);
  }

  /**
   * Exportación para la asesoría: facturas (por tipo de IVA), cobros y fianzas
   * del periodo. `format=json` (vista previa), `csv` (una tabla según `kind`)
   * o `xlsx` (tres hojas).
   */
  @Get('accountant-export')
  async accountantExport(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query() query: Record<string, string>,
  ): Promise<void> {
    assertAllFacilities(user);
    const parsed = AccountantExportQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'Indica el periodo (desde y hasta)',
      });
    }
    const { from, to, format, kind } = parsed.data;
    const dto = await this.accountant.buildForTenant(
      user.tenantId,
      from,
      to,
      parseOwner(query.ownerId),
    );
    if (format === 'json') {
      res.json(dto);
      return;
    }
    const name = `asesoria-${from}-a-${to}`;
    if (format === 'xlsx') {
      const buf = await this.accountant.toXlsx(dto, true);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      res.send(buf);
      return;
    }
    const csv =
      kind === 'payments'
        ? toAccountantCsv(withoutActivity(ACCOUNTANT_PAYMENT_COLUMNS), dto.payments)
        : kind === 'deposits'
          ? toAccountantCsv(withoutActivity(ACCOUNTANT_DEPOSIT_COLUMNS), dto.deposits)
          : kind === 'expenses'
            ? toAccountantCsv(ACCOUNTANT_EXPENSE_COLUMNS, dto.expenses)
            : toAccountantCsv(withoutActivity(ACCOUNTANT_INVOICE_COLUMNS), dto.invoices);
    const suffix = {
      invoices: 'facturas',
      payments: 'cobros',
      deposits: 'fianzas',
      expenses: 'gastos',
    }[kind];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${suffix}.csv"`);
    res.send(csv);
  }

  @Get('vat-book')
  vatBook(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<VatBookDto> {
    assertAllFacilities(user);
    if (!from || !to) {
      throw new BadRequestException({ code: 'range_required', message: 'Indica from y to' });
    }
    return this.fiscal.vatBook(user.tenantId, from, to, parseOwner(ownerId));
  }

  @Get('model-303')
  model303(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('quarter') quarter: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<Model303Dto> {
    assertAllFacilities(user);
    return this.fiscal.model303(
      user.tenantId,
      parseYear(year),
      parseQuarter(quarter),
      parseOwner(ownerId),
    );
  }

  @Get('model-347')
  model347(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<Model347Dto> {
    assertAllFacilities(user);
    return this.fiscal.model347(user.tenantId, parseYear(year), parseOwner(ownerId));
  }

  /** Exportación contable genérica (A3/Sage y similares): una fila por factura×tipo de IVA. */
  @Get('accounting-export')
  accountingExport(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<AccountingExportDto> {
    assertAllFacilities(user);
    if (!from || !to) {
      throw new BadRequestException({ code: 'range_required', message: 'Indica from y to' });
    }
    return this.fiscal.accountingExport(user.tenantId, from, to, parseOwner(ownerId));
  }
}

/**
 * Emisor de los informes (plan Administrador): vacío o `self` = el propio
 * negocio; un id = ese propietario (cada uno declara lo suyo).
 */
function parseOwner(value: string | undefined): string | null {
  if (!value || value === 'self') return null;
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw new BadRequestException({ code: 'invalid_owner', message: 'Propietario no válido' });
  }
  return value;
}
