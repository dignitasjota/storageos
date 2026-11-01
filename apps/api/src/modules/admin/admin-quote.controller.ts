import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminQuoteSchema, SendAdminQuoteSchema, UpdateQuoteOfferSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminQuoteService } from './admin-quote.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type {
  AdminQuoteDto,
  PlatformQuoteOfferDto,
  PlatformQuoteOffersDto,
} from '@storageos/shared';
import type { Request } from 'express';

class AdminQuoteBody extends createZodDto(AdminQuoteSchema) {}
class SendAdminQuoteBody extends createZodDto(SendAdminQuoteSchema) {}
class UpdateQuoteOfferBody extends createZodDto(UpdateQuoteOfferSchema) {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Simulador de cuota y envío como propuesta. */
@Public()
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminQuoteController {
  constructor(private readonly service: AdminQuoteService) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  quote(@Body() body: AdminQuoteBody): Promise<AdminQuoteDto> {
    return this.service.quote(body);
  }

  @RequireSuperadmin()
  @Post('tenants/:id/quote-offers')
  send(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendAdminQuoteBody,
    @Req() req: Request,
  ): Promise<{ recipients: number; quote: AdminQuoteDto; offerId: string }> {
    return this.service.send(id, body, {
      superAdminId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  /** Propuestas enviadas (de un tenant con `?tenantId=`) y su conversión. */
  @Get('quote-offers')
  offers(@Query('tenantId') tenantId?: string): Promise<PlatformQuoteOffersDto> {
    return this.service.listOffers(tenantId && UUID_RE.test(tenantId) ? tenantId : undefined);
  }

  /** Marcar una propuesta como aceptada, rechazada o volver a «enviada». */
  @RequireSuperadmin()
  @Patch('quote-offers/:id')
  setStatus(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateQuoteOfferBody,
  ): Promise<PlatformQuoteOfferDto> {
    return this.service.setOfferStatus(id, body.status, admin.sub);
  }
}
