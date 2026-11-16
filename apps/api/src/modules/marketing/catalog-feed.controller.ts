import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CatalogFeedService } from './catalog-feed.service';

import type { Response } from 'express';

@Controller('marketing')
export class CatalogFeedController {
  constructor(private readonly feed: CatalogFeedService) {}

  /**
   * Export CSV del catálogo (local × tipo de trastero disponible), para
   * copiar/pegar o subir a portales inmobiliarios (Idealista, Fotocasa,
   * Wallapop…). Devuelve el fichero directamente (`@Res()`), con BOM UTF-8 y
   * separador `;` para Excel es-ES.
   */
  @RequirePermission('marketing:read')
  @Get('catalog-feed')
  async exportCatalogFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query('facilityId') facilityId?: string,
  ): Promise<void> {
    if (facilityId && !/^[0-9a-f-]{36}$/i.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    const csv = await this.feed.exportCsv(
      user.tenantId,
      facilityId || undefined,
      user.facilityScope ?? null,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="catalogo-trasteros.csv"');
    res.send(csv);
  }
}
