import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import {
  ACCOUNTANT_DEPOSIT_COLUMNS,
  ACCOUNTANT_INVOICE_COLUMNS,
  ACCOUNTANT_PAYMENT_COLUMNS,
  AccountantExportQuerySchema,
  toAccountantCsv,
  withoutActivity,
} from '@storageos/shared';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AccountantExportService } from '../billing-saas/accountant-export.service';

import { FiscalService } from './fiscal.service';

import type { AccountingExportDto, Model303Dto, Model347Dto, VatBookDto } from '@storageos/shared';
import type { Response } from 'express';

function parseYear(raw: string | undefined): number {
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new BadRequestException({ code: 'invalid_year', message: 'Año no válido' });
  }
  return y;
}

@RequirePermission('invoices:manage')
@Controller('fiscal')
export class FiscalController {
  constructor(
    private readonly fiscal: FiscalService,
    private readonly accountant: AccountantExportService,
  ) {}

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
          : toAccountantCsv(withoutActivity(ACCOUNTANT_INVOICE_COLUMNS), dto.invoices);
    const suffix = { invoices: 'facturas', payments: 'cobros', deposits: 'fianzas' }[kind];
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
    return this.fiscal.model303(
      user.tenantId,
      parseYear(year),
      Number(quarter),
      parseOwner(ownerId),
    );
  }

  @Get('model-347')
  model347(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<Model347Dto> {
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
