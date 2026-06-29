import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../database/prisma.service';
import { PaymentMethodsService } from '../payment-methods.service';

import { GoCardlessClient } from './gocardless-client';
import { GoCardlessSettingsService } from './gocardless-settings.service';

import type { Env } from '../../../config/env.schema';
import type { RequestMeta } from '../../auth/auth.service';
import type { GoCardlessMandateStartDto, PaymentMethodDto } from '@storageos/shared';

/**
 * Orquesta el mandato SEPA de GoCardless vía Billing Request Flow:
 *  - `startFlow`: crea el billing request + su flow → URL de autorización.
 *  - `completeFlow`: tras volver el cliente, lee el mandato y lo guarda como
 *    `PaymentMethod` (gateway `gocardless`, type `sepa_debit`).
 *
 * El estado del flujo lo lleva el frontend (billingRequestId); no hace falta
 * tabla. El billing request queda implícitamente acotado al tenant porque se
 * consulta con SU access token (otro tenant → 404 de GoCardless).
 */
@Injectable()
export class GoCardlessMandatesService {
  constructor(
    private readonly settings: GoCardlessSettingsService,
    private readonly client: GoCardlessClient,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Inicia el flujo de autorización del mandato. `returnPath` es la ruta del frontend de retorno. */
  async startFlow(args: {
    tenantId: string;
    customerId: string;
    returnPath: string;
  }): Promise<GoCardlessMandateStartDto> {
    const resolved = await this.requireEnabled(args.tenantId);
    await this.requireCustomer(args.tenantId, args.customerId);

    const { id: billingRequestId } = await this.client.createBillingRequest(
      resolved.accessToken,
      resolved.environment,
    );
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const { authorisationUrl } = await this.client.createBillingRequestFlow(
      resolved.accessToken,
      resolved.environment,
      {
        billingRequestId,
        redirectUri: `${webBase}${args.returnPath}`,
        exitUri: `${webBase}${args.returnPath}?cancelled=1`,
      },
    );
    return { authorisationUrl, billingRequestId };
  }

  /** Completa el flujo: verifica el mandato y lo registra como método de pago. */
  async completeFlow(args: {
    tenantId: string;
    userId: string | null;
    customerId: string;
    billingRequestId: string;
    meta: RequestMeta;
  }): Promise<PaymentMethodDto> {
    const resolved = await this.requireEnabled(args.tenantId);
    await this.requireCustomer(args.tenantId, args.customerId);

    const br = await this.client.getBillingRequest(
      resolved.accessToken,
      resolved.environment,
      args.billingRequestId,
    );
    if (br.status !== 'fulfilled' || !br.mandateId) {
      throw new BadRequestException({
        code: 'mandate_not_authorised',
        message: 'El mandato aún no está autorizado',
      });
    }

    const mandate = await this.client.getMandate(
      resolved.accessToken,
      resolved.environment,
      br.mandateId,
    );
    const bankAccountId = br.bankAccountId ?? mandate.bankAccountId;
    let last4: string | null = null;
    let bankName: string | null = null;
    if (bankAccountId) {
      const ba = await this.client.getCustomerBankAccount(
        resolved.accessToken,
        resolved.environment,
        bankAccountId,
      );
      last4 = ba.accountNumberEnding;
      bankName = ba.bankName;
    }

    return this.paymentMethods.registerResolved({
      tenantId: args.tenantId,
      userId: args.userId,
      customerId: args.customerId,
      gateway: 'gocardless',
      type: 'sepa_debit',
      token: mandate.id,
      gatewayCustomerId: br.customerId,
      last4,
      brand: bankName ?? 'SEPA',
      mandateReference: mandate.reference,
      isDefault: true,
      meta: args.meta,
    });
  }

  /** ¿Tiene el tenant GoCardless activado? (para mostrar el botón en el portal). */
  async isEnabled(tenantId: string): Promise<boolean> {
    return (await this.settings.get(tenantId)).enabled;
  }

  private async requireEnabled(tenantId: string) {
    const resolved = await this.settings.getResolved(tenantId);
    if (!resolved?.enabled) {
      throw new BadRequestException({
        code: 'gocardless_not_enabled',
        message: 'GoCardless no está activado en este negocio',
      });
    }
    return resolved;
  }

  private async requireCustomer(tenantId: string, customerId: string): Promise<void> {
    const customer = await this.prisma.withTenant(
      (tx) => tx.customer.findFirst({ where: { id: customerId, deletedAt: null } }),
      tenantId,
    );
    if (!customer) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
  }
}
