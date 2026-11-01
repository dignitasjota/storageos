import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';

import { CatalogPriceHistoryService } from './catalog-price-history.service';

import type { CatalogPriceChangeDto } from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Histórico de precios del catálogo (planes y extras). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly history: CatalogPriceHistoryService) {}

  @Get('price-history')
  priceHistory(
    @Query('kind') kind: string,
    @Query('itemId') itemId?: string,
  ): Promise<CatalogPriceChangeDto[]> {
    if (kind !== 'plan' && kind !== 'addon') {
      throw new BadRequestException({ code: 'invalid_kind', message: 'Tipo no válido' });
    }
    if (itemId && !UUID_RE.test(itemId)) {
      throw new BadRequestException({ code: 'invalid_id', message: 'Identificador no válido' });
    }
    return this.history.list(kind, itemId);
  }
}
