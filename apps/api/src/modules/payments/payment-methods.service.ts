import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { PaymentMethod, Prisma } from '@storageos/database';
import type {
  CreateSetupIntentInput,
  PaymentMethodDto,
  RegisterPaymentMethodInput,
  SetupIntentResponseDto,
} from '@storageos/shared';

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(tenantId: string, customerId: string): Promise<PaymentMethodDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.paymentMethod.findMany({
          where: { customerId, deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Stripe no está configurado si la clave es el placeholder por defecto
   * (`sk_test_dummy`): cualquier llamada a la API fallaría con un 500 opaco, así
   * que lo cortamos antes con un error claro.
   */
  private assertGatewayConfigured(): void {
    const key = this.config.get('STRIPE_SECRET_KEY', { infer: true });
    if (!key || key === 'sk_test_dummy') {
      throw new ServiceUnavailableException({
        code: 'payments_not_configured',
        message:
          'El pago online con tarjeta o IBAN no está disponible todavía. Contacta con tu operador.',
      });
    }
  }

  async createSetupIntent(
    tenantId: string,
    input: CreateSetupIntentInput,
  ): Promise<SetupIntentResponseDto> {
    this.assertGatewayConfigured();
    // Resolver/crear el Stripe customer del cliente final.
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findUniqueOrThrow({
          where: { id: input.customerId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            customerType: true,
            paymentMethods: {
              where: { deletedAt: null, gateway: this.gateway.providerName },
              select: { gatewayCustomerId: true },
              take: 1,
            },
          },
        }),
      tenantId,
    );
    let gatewayCustomerId = customer.paymentMethods[0]?.gatewayCustomerId ?? null;
    if (!gatewayCustomerId) {
      const created = await this.gateway.createCustomer({
        email: customer.email,
        name:
          customer.customerType === 'business'
            ? (customer.companyName ?? 'Empresa')
            : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() ||
              'Sin nombre',
        metadata: { tenantId, customerId: customer.id },
      });
      gatewayCustomerId = created.gatewayCustomerId;
    }
    const intent = await this.gateway.createSetupIntent({ gatewayCustomerId });
    return {
      clientSecret: intent.clientSecret,
      setupIntentId: intent.setupIntentId,
      customerId: gatewayCustomerId,
      publishableKey: this.config.get('STRIPE_PUBLISHABLE_KEY', { infer: true }),
    };
  }

  async register(args: {
    tenantId: string;
    /** `null` cuando el alta la hace el inquilino desde el portal. */
    userId: string | null;
    input: RegisterPaymentMethodInput;
    meta: RequestMeta;
  }): Promise<PaymentMethodDto> {
    const details = await this.gateway.getPaymentMethodDetails(args.input.gatewayToken);
    // El tipo real lo dicta el gateway (un PM sepa_debit registrado como
    // 'card' rompería el cobro posterior); el input es solo fallback para
    // tipos que el gateway no mapea.
    const resolvedType = details.type ?? args.input.type;
    const encrypted = this.crypto.encryptString(args.input.gatewayToken);
    const created = await this.prisma.withTenant(async (tx) => {
      if (args.input.isDefault) {
        await tx.paymentMethod.updateMany({
          where: { customerId: args.input.customerId, deletedAt: null },
          data: { isDefault: false },
        });
      }
      return tx.paymentMethod.create({
        data: {
          tenantId: args.tenantId,
          customerId: args.input.customerId,
          type: resolvedType,
          gateway: this.gateway.providerName,
          gatewayTokenEncrypted: encrypted,
          ...(args.input.gatewayCustomerId
            ? { gatewayCustomerId: args.input.gatewayCustomerId }
            : {}),
          last4: details.last4 ?? args.input.last4 ?? null,
          brand: details.brand ?? args.input.brand ?? null,
          expMonth: details.expMonth ?? args.input.expMonth ?? null,
          expYear: details.expYear ?? args.input.expYear ?? null,
          isDefault: args.input.isDefault,
          mandateReference: details.mandateReference ?? args.input.mandateReference ?? null,
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'payment_method.added',
      entityType: 'PaymentMethod',
      entityId: created.id,
      changes: { customerId: args.input.customerId, type: resolvedType },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  /**
   * Registra un método de pago **ya resuelto** (sin llamar a un gateway): los
   * detalles llegan desde fuera. Lo usa GoCardless, cuyo "token" es el id del
   * mandato y cuyos datos (referencia, IBAN, customer) ya se obtuvieron del
   * Billing Request — el flujo Stripe de `register` no aplica.
   */
  async registerResolved(args: {
    tenantId: string;
    userId: string | null;
    customerId: string;
    gateway: PaymentMethod['gateway'];
    type: PaymentMethod['type'];
    /** Token/identificador que se cifra (p. ej. el id del mandato de GoCardless). */
    token: string;
    gatewayCustomerId?: string | null;
    last4?: string | null;
    brand?: string | null;
    mandateReference?: string | null;
    isDefault: boolean;
    meta: RequestMeta;
  }): Promise<PaymentMethodDto> {
    const encrypted = this.crypto.encryptString(args.token);
    const created = await this.prisma.withTenant(async (tx) => {
      if (args.isDefault) {
        await tx.paymentMethod.updateMany({
          where: { customerId: args.customerId, deletedAt: null },
          data: { isDefault: false },
        });
      }
      return tx.paymentMethod.create({
        data: {
          tenantId: args.tenantId,
          customerId: args.customerId,
          type: args.type,
          gateway: args.gateway,
          gatewayTokenEncrypted: encrypted,
          ...(args.gatewayCustomerId ? { gatewayCustomerId: args.gatewayCustomerId } : {}),
          last4: args.last4 ?? null,
          brand: args.brand ?? null,
          isDefault: args.isDefault,
          mandateReference: args.mandateReference ?? null,
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'payment_method.added',
      entityType: 'PaymentMethod',
      entityId: created.id,
      changes: { customerId: args.customerId, type: args.type, gateway: args.gateway },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    paymentMethodId: string;
    meta: RequestMeta;
  }): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.paymentMethod.findUnique({ where: { id: args.paymentMethodId } }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'payment_method_not_found',
        message: 'Metodo no encontrado',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.paymentMethod.update({
          where: { id: args.paymentMethodId },
          data: { deletedAt: new Date(), isDefault: false },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'payment_method.removed',
      entityType: 'PaymentMethod',
      entityId: args.paymentMethodId,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /** Lee el token plaintext (descifrado) para usarlo en charges. Solo desde el service. */
  async decryptToken(tx: Prisma.TransactionClient, paymentMethodId: string): Promise<string> {
    const pm = await tx.paymentMethod.findUniqueOrThrow({
      where: { id: paymentMethodId },
    });
    return this.crypto.decryptString(pm.gatewayTokenEncrypted);
  }

  private toDto(row: PaymentMethod): PaymentMethodDto {
    return {
      id: row.id,
      customerId: row.customerId,
      type: row.type,
      gateway: row.gateway,
      last4: row.last4,
      brand: row.brand,
      expMonth: row.expMonth,
      expYear: row.expYear,
      isDefault: row.isDefault,
      mandateReference: row.mandateReference,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
