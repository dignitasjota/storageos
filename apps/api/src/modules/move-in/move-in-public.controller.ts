import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type BookingAvailabilityDto,
  type BookingResultDto,
  CaptureBookingLeadSchema,
  type ContractSignViewDto,
  PublicBookingSchema,
  PublicSignSubmitSchema,
  type SignResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { BookingService } from './booking.service';
import { SignaturesService } from './signatures.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class PublicBookingBody extends createZodDto(PublicBookingSchema) {}
class CaptureBookingLeadBody extends createZodDto(CaptureBookingLeadSchema) {}
class PublicSignBody extends createZodDto(PublicSignSubmitSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Endpoints públicos del move-in self-service y de la firma electrónica.
 * Sin auth; throttle estricto por IP. La firma se resuelve por token opaco;
 * el booking por slug del tenant.
 */
@Public()
@Controller('public/move-in')
export class MoveInPublicController {
  constructor(
    private readonly booking: BookingService,
    private readonly signatures: SignaturesService,
  ) {}

  @Get('book/:slug/availability')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  availability(@Param('slug') slug: string): Promise<BookingAvailabilityDto> {
    return this.booking.availability(slug);
  }

  @Post('book/:slug')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  book(
    @Param('slug') slug: string,
    @Body() body: PublicBookingBody,
    @Req() req: Request,
  ): Promise<BookingResultDto> {
    return this.booking.createBooking(slug, body, extractMeta(req));
  }

  /** Captura email-first: guarda un lead en cuanto el visitante deja su email. */
  @Post('book/:slug/lead')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  captureLead(
    @Param('slug') slug: string,
    @Body() body: CaptureBookingLeadBody,
    @Req() req: Request,
  ): Promise<{ captured: boolean }> {
    return this.booking.captureLead(slug, body, extractMeta(req));
  }

  @Get('sign/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  signView(@Param('token') token: string): Promise<ContractSignViewDto> {
    return this.signatures.getSignView(token);
  }

  @Post('sign/:token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  sign(
    @Param('token') token: string,
    @Body() body: PublicSignBody,
    @Req() req: Request,
  ): Promise<SignResultDto> {
    return this.signatures.signViaToken(token, body, extractMeta(req));
  }
}
