import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminQuoteSchema, SendAdminQuoteSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminQuoteService } from './admin-quote.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { AdminQuoteDto } from '@storageos/shared';
import type { Request } from 'express';

class AdminQuoteBody extends createZodDto(AdminQuoteSchema) {}
class SendAdminQuoteBody extends createZodDto(SendAdminQuoteSchema) {}

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
  ): Promise<{ recipients: number; quote: AdminQuoteDto }> {
    return this.service.send(id, body, {
      superAdminId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
