import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type SepaMandateSignViewDto, SignSepaMandateSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { SepaService } from './sepa.service';

import type { Request } from 'express';

class SignSepaMandateBody extends createZodDto(SignSepaMandateSchema) {}

/**
 * Firma del mandato SEPA por el inquilino, por el enlace que le llega por
 * correo (token opaco de un solo uso, 30 días). Sin sesión.
 */
@Public()
@Controller('public/sepa-mandates')
export class SepaMandatePublicController {
  constructor(private readonly sepa: SepaService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  view(@Param('token') token: string): Promise<SepaMandateSignViewDto> {
    return this.sepa.getSignView(token);
  }

  @Post(':token/sign')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sign(
    @Param('token') token: string,
    @Body() body: SignSepaMandateBody,
    @Req() req: Request,
  ): Promise<{ signed: true }> {
    return this.sepa.signByToken(token, body, {
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
