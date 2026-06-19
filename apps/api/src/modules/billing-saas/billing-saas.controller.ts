import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  CreateCheckoutSessionSchema,
  CreatePortalSessionSchema,
  type BillingSessionResponseDto,
  type TenantSubscriptionDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { BillingSaasService } from './billing-saas.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateCheckoutSessionDto extends createZodDto(CreateCheckoutSessionSchema) {}
class CreatePortalSessionDto extends createZodDto(CreatePortalSessionSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Endpoints para que el OWNER del tenant gestione su suscripcion SaaS.
 *
 * Distinto de `/payments` (Fase 4, cobros a inquilinos) y de
 * `/settings/billing` (series de factura del tenant). Aqui solo se opera
 * con Stripe Checkout / Billing Portal de la propia suscripcion de la
 * plataforma.
 *
 * Solo `owner` puede gestionar la suscripcion porque implica responsabilidad
 * de pago hacia nosotros.
 */
@Controller('settings/saas-billing')
@RequirePermission('billing:configure')
export class BillingSaasController {
  constructor(private readonly service: BillingSaasService) {}

  @Get()
  async getCurrent(@CurrentUser() user: AuthenticatedUser): Promise<TenantSubscriptionDto> {
    return this.service.getCurrentSubscription(user.tenantId);
  }

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  async checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateCheckoutSessionDto,
    @Req() req: Request,
  ): Promise<BillingSessionResponseDto> {
    return this.service.createCheckoutSession({
      tenantId: user.tenantId,
      userId: user.sub,
      planId: input.planId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      meta: extractMeta(req),
    });
  }

  @Post('portal')
  @HttpCode(HttpStatus.OK)
  async portal(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreatePortalSessionDto,
    @Req() req: Request,
  ): Promise<BillingSessionResponseDto> {
    return this.service.createPortalSession({
      tenantId: user.tenantId,
      userId: user.sub,
      returnUrl: input.returnUrl,
      meta: extractMeta(req),
    });
  }
}
