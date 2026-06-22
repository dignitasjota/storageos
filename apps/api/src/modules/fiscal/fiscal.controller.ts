import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { FiscalService } from './fiscal.service';

import type { Model303Dto, Model347Dto, VatBookDto } from '@storageos/shared';

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
  constructor(private readonly fiscal: FiscalService) {}

  @Get('vat-book')
  vatBook(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<VatBookDto> {
    if (!from || !to) {
      throw new BadRequestException({ code: 'range_required', message: 'Indica from y to' });
    }
    return this.fiscal.vatBook(user.tenantId, from, to);
  }

  @Get('model-303')
  model303(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('quarter') quarter: string,
  ): Promise<Model303Dto> {
    return this.fiscal.model303(user.tenantId, parseYear(year), Number(quarter));
  }

  @Get('model-347')
  model347(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
  ): Promise<Model347Dto> {
    return this.fiscal.model347(user.tenantId, parseYear(year));
  }
}
