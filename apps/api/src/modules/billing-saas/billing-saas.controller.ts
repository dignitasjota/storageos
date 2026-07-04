import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  CreateCheckoutSessionSchema,
  CreatePortalSessionSchema,
  SelfAssignAddonSchema,
  type BillingSessionResponseDto,
  type PlatformInvoiceDto,
  type TenantSelfAddonsDto,
  type TenantSubscriptionDto,
  type TenantSubscriptionPaymentDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { BillingSaasService } from './billing-saas.service';
import { PlatformInvoicesService } from './platform-invoices.service';
import { SaasAddonsService } from './saas-addons.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateCheckoutSessionDto extends createZodDto(CreateCheckoutSessionSchema) {}
class CreatePortalSessionDto extends createZodDto(CreatePortalSessionSchema) {}
class SelfAssignAddonDto extends createZodDto(SelfAssignAddonSchema) {}

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
  constructor(
    private readonly service: BillingSaasService,
    private readonly addons_: SaasAddonsService,
    private readonly invoices: PlatformInvoicesService,
  ) {}

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

  // --- Add-ons self-service (el tenant contrata extras) ---

  @Get('addons')
  addons(@CurrentUser() user: AuthenticatedUser): Promise<TenantSelfAddonsDto> {
    return this.addons_.selfServiceView(user.tenantId);
  }

  @Post('addons')
  @HttpCode(HttpStatus.OK)
  contractAddon(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SelfAssignAddonDto,
  ): Promise<TenantSelfAddonsDto> {
    return this.addons_.selfAssign(user.tenantId, body.addonId, body.quantity);
  }

  @Delete('addons/:assignmentId')
  cancelAddon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ): Promise<TenantSelfAddonsDto> {
    return this.addons_.selfRemove(user.tenantId, assignmentId);
  }

  // --- Facturas de la plataforma + historial de pagos (lo que paga el tenant) ---

  /** Facturas que StorageOS emite al tenant por su suscripción. */
  @Get('invoices')
  listInvoices(@CurrentUser() user: AuthenticatedUser): Promise<PlatformInvoiceDto[]> {
    return this.invoices.listForTenant(user.tenantId);
  }

  /** URL firmada del PDF de una factura del propio tenant. */
  @Get('invoices/:id/pdf')
  invoicePdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ url: string }> {
    return this.invoices.getPdfUrlForTenant(id, user.tenantId);
  }

  /** Historial de pagos de la suscripción SaaS del tenant. */
  @Get('payments')
  listPayments(@CurrentUser() user: AuthenticatedUser): Promise<TenantSubscriptionPaymentDto[]> {
    return this.service.listSaasPayments(user.tenantId);
  }
}
