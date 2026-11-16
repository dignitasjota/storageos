import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminQuoteService } from '../admin-quote.service';

import { SalesAssignmentService } from './sales-assignment.service';

import type { SalesCodeCheckDto } from '@storageos/shared';
import type { Response } from 'express';

/** Comprobar un código de comercial (registro y formularios de la web). */
@Public()
@Controller('public/sales')
export class SalesPublicController {
  constructor(private readonly assignment: SalesAssignmentService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('code/:code')
  check(@Param('code') code: string): Promise<SalesCodeCheckDto> {
    return this.assignment.checkCode(code.slice(0, 40));
  }
}

/**
 * Enlace de una propuesta en su correo: anota cuándo la abrió y lleva a
 * aceptarla (Suscripción) o a crear la cuenta.
 */
@Public()
@Controller('public/offers')
export class QuoteOfferOpenController {
  constructor(private readonly quotes: AdminQuoteService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':id/open')
  async open(
    @Param('id') id: string,
    @Query('sig') sig: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.quotes.openOffer(id, sig);
    res.redirect(302, url);
  }
}
