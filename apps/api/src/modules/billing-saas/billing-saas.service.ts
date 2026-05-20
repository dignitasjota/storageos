import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import StripeSDK from 'stripe';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { StripeGateway } from '../payments/stripe.gateway';

import type { RequestMeta } from '../auth/auth.service';
import type { SubscriptionStatus } from '@storageos/database';
import type {
  BillingSessionResponseDto,
  SubscriptionPlanDto,
  TenantSubscriptionDto,
} from '@storageos/shared';

// El SDK de Stripe exporta `Stripe` como namespace y como clase con el mismo
// nombre. El import por defecto resuelve al constructor; para acceder a los
// tipos anidados (Stripe.Checkout.Session, Stripe.BillingPortal.Session)
// usamos los tipos inferidos del cliente. Patron alineado con
// `stripe.gateway.ts`.
type StripeClient = InstanceType<typeof StripeSDK>;
type CheckoutSession = Awaited<ReturnType<StripeClient['checkout']['sessions']['create']>>;
type BillingPortalSession = Awaited<
  ReturnType<StripeClient['billingPortal']['sessions']['create']>
>;

/**
 * Mapea los `status` de Stripe Subscription a nuestro enum `subscription_status`.
 * Stripe usa: incomplete | incomplete_expired | trialing | active |
 * past_due | canceled | unpaid | paused.
 */
function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'cancelled';
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return 'expired';
    default:
      return 'expired';
  }
}

/**
 * Servicio de facturacion SaaS del tenant (Fase 8B).
 *
 * Distinto de `PaymentsService` (Fase 4): aquel se ocupa de que los tenants
 * cobren a sus inquilinos. Este se ocupa de que los tenants nos paguen a
 * nosotros (la plataforma) via Stripe Checkout + Billing Portal.
 *
 * - `createCheckoutSession`: redirige al tenant al Stripe Checkout para
 *   contratar / cambiar un plan. Si no tiene `stripeCustomerId`, lo crea
 *   primero y lo persiste en `tenant_subscriptions`.
 * - `createPortalSession`: redirige al Stripe Billing Portal donde el tenant
 *   puede gestionar su tarjeta, cancelar, descargar facturas, etc.
 * - `syncSubscriptionFromStripe`: invocado desde el webhook para mantener
 *   nuestra BD coherente con Stripe (status, currentPeriodEnd, cancelAtPeriodEnd).
 */
@Injectable()
export class BillingSaasService {
  private readonly logger = new Logger(BillingSaasService.name);
  private readonly stripe: StripeClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    stripeGateway: StripeGateway,
  ) {
    this.stripe = stripeGateway.getClient();
  }

  /** Lee la suscripcion vigente del tenant con su plan asociado. */
  async getCurrentSubscription(tenantId: string): Promise<TenantSubscriptionDto> {
    const sub = await this.prisma.withTenant(
      (tx) =>
        tx.tenantSubscription.findUnique({
          where: { tenantId },
          include: { plan: true },
        }),
      tenantId,
    );
    if (!sub) {
      throw new NotFoundException({
        code: 'subscription_not_found',
        message: 'El tenant no tiene suscripcion',
      });
    }
    return this.toDto(sub);
  }

  /**
   * Crea una Stripe Checkout Session para suscribir al tenant al plan
   * indicado. Devuelve la URL a la que redirigir el navegador.
   *
   * Si el tenant aun no tiene `stripeCustomerId`, lo creamos primero.
   */
  async createCheckoutSession(args: {
    tenantId: string;
    userId: string;
    planId: string;
    successUrl: string;
    cancelUrl: string;
    meta: RequestMeta;
  }): Promise<BillingSessionResponseDto> {
    // Resolver tenant + plan en paralelo. El tenant lo leemos por admin
    // porque necesitamos su email/nombre para Stripe Customer.
    const [tenant, plan] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: args.tenantId } }),
      this.admin.subscriptionPlan.findUnique({ where: { id: args.planId } }),
    ]);
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if (!plan) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    if (!plan.isActive) {
      throw new BadRequestException({ code: 'plan_inactive', message: 'El plan no esta activo' });
    }
    if (!plan.stripePriceId) {
      throw new BadRequestException({
        code: 'plan_inactive',
        message: 'El plan no tiene un Stripe price configurado',
      });
    }

    // Obtener o crear el Stripe Customer.
    const stripeCustomerId = await this.getOrCreateStripeCustomer({
      tenantId: args.tenantId,
      tenantName: tenant.name,
      billingEmail: tenant.billingEmail,
    });

    let session: CheckoutSession;
    try {
      session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
        client_reference_id: args.tenantId,
        subscription_data: {
          metadata: {
            tenantId: args.tenantId,
            planId: plan.id,
            planSlug: plan.slug,
          },
        },
        metadata: {
          tenantId: args.tenantId,
          planId: plan.id,
        },
      });
    } catch (err) {
      this.logger.error(
        `Stripe checkout.sessions.create fallo para tenant ${args.tenantId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException({
        code: 'stripe_api_error',
        message: 'No se pudo crear la sesion de checkout',
      });
    }

    if (!session.url) {
      throw new InternalServerErrorException({
        code: 'stripe_api_error',
        message: 'Stripe no devolvio URL de checkout',
      });
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'saas_billing.checkout_started',
      entityType: 'TenantSubscription',
      entityId: null,
      changes: {
        planId: plan.id,
        planSlug: plan.slug,
        stripeSessionId: session.id,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return { url: session.url };
  }

  /**
   * Crea una sesion del Stripe Billing Portal para que el owner gestione
   * la suscripcion (cancelar, cambiar tarjeta, ver facturas).
   */
  async createPortalSession(args: {
    tenantId: string;
    userId: string;
    returnUrl: string;
    meta: RequestMeta;
  }): Promise<BillingSessionResponseDto> {
    const sub = await this.prisma.withTenant(
      (tx) => tx.tenantSubscription.findUnique({ where: { tenantId: args.tenantId } }),
      args.tenantId,
    );
    if (!sub || !sub.stripeCustomerId) {
      throw new BadRequestException({
        code: 'no_stripe_customer',
        message: 'El tenant todavia no esta vinculado a Stripe. Inicia primero un checkout.',
      });
    }

    let session: BillingPortalSession;
    try {
      session = await this.stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: args.returnUrl,
      });
    } catch (err) {
      this.logger.error(
        `Stripe billingPortal.sessions.create fallo para tenant ${args.tenantId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException({
        code: 'stripe_api_error',
        message: 'No se pudo abrir el portal de facturacion',
      });
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'saas_billing.portal_opened',
      entityType: 'TenantSubscription',
      entityId: sub.id,
      changes: { stripeCustomerId: sub.stripeCustomerId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return { url: session.url };
  }

  /**
   * Sincroniza el estado de la suscripcion local con los datos de un evento
   * de Stripe Webhook. Se invoca desde `StripeWebhookController` para los
   * eventos `customer.subscription.{created,updated,deleted}` y
   * `invoice.payment_{succeeded,failed}`.
   *
   * No requiere tenant context: resolvemos el tenant via:
   *   1. `metadata.tenantId` del objeto Stripe (lo seteamos al crear el
   *      Checkout y el SetupIntent del SaaS).
   *   2. fallback por `stripe_customer_id` / `stripe_subscription_id` en BD.
   */
  async syncSubscriptionFromStripe(args: {
    stripeSubscriptionId: string;
    stripeCustomerId: string;
    tenantIdHint: string | null;
    status: string;
    currentPeriodStart: number;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
    planIdHint?: string | null;
  }): Promise<void> {
    // Resolver tenantId.
    const tenantId = await this.resolveTenantId({
      tenantIdHint: args.tenantIdHint,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripeCustomerId: args.stripeCustomerId,
    });
    if (!tenantId) {
      this.logger.warn(
        `Webhook saas billing recibido sin tenantId resoluble (subId=${args.stripeSubscriptionId})`,
      );
      return;
    }

    const newStatus = mapStripeStatus(args.status);
    const periodStart = new Date(args.currentPeriodStart * 1000);
    const periodEnd = new Date(args.currentPeriodEnd * 1000);

    // Bypass RLS: este flujo nace de webhook publico, sin contexto de tenant
    // del lado HTTP. La tabla `tenant_subscriptions` lleva RLS pero el cliente
    // admin es owner y la salta. Es legitimo aqui.
    const updated = await this.admin.tenantSubscription.update({
      where: { tenantId },
      data: {
        status: newStatus,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: args.cancelAtPeriodEnd,
        stripeSubscriptionId: args.stripeSubscriptionId,
        stripeCustomerId: args.stripeCustomerId,
        ...(args.planIdHint ? { planId: args.planIdHint } : {}),
      },
    });

    await this.audit.write({
      tenantId,
      userId: null,
      action: 'saas_billing.subscription_updated',
      entityType: 'TenantSubscription',
      entityId: updated.id,
      changes: {
        status: newStatus,
        cancelAtPeriodEnd: args.cancelAtPeriodEnd,
        stripeSubscriptionId: args.stripeSubscriptionId,
        currentPeriodEnd: periodEnd.toISOString(),
      },
      ipAddress: null,
      userAgent: null,
    });
  }

  /**
   * Marca la suscripcion como pago fallido tras `invoice.payment_failed`.
   * No cambiamos status si Stripe no nos lo dice — solo loggeamos y
   * delegamos en `customer.subscription.updated` que llega justo despues.
   */
  async recordInvoicePaymentFailed(args: {
    stripeCustomerId: string;
    stripeSubscriptionId: string | null;
    tenantIdHint: string | null;
  }): Promise<void> {
    const tenantId = await this.resolveTenantId({
      tenantIdHint: args.tenantIdHint,
      stripeSubscriptionId: args.stripeSubscriptionId ?? '',
      stripeCustomerId: args.stripeCustomerId,
    });
    if (!tenantId) return;
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'saas_billing.invoice_payment_failed',
      entityType: 'TenantSubscription',
      entityId: null,
      changes: {
        stripeCustomerId: args.stripeCustomerId,
        ...(args.stripeSubscriptionId ? { stripeSubscriptionId: args.stripeSubscriptionId } : {}),
      },
      ipAddress: null,
      userAgent: null,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  private async getOrCreateStripeCustomer(args: {
    tenantId: string;
    tenantName: string;
    billingEmail: string | null;
  }): Promise<string> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.tenantSubscription.findUnique({ where: { tenantId: args.tenantId } }),
      args.tenantId,
    );
    if (existing?.stripeCustomerId) return existing.stripeCustomerId;

    let customerId: string;
    try {
      const customer = await this.stripe.customers.create({
        name: args.tenantName,
        ...(args.billingEmail ? { email: args.billingEmail } : {}),
        metadata: {
          tenantId: args.tenantId,
          source: 'saas_billing',
        },
      });
      customerId = customer.id;
    } catch (err) {
      this.logger.error(
        `Stripe customers.create fallo para tenant ${args.tenantId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException({
        code: 'stripe_api_error',
        message: 'No se pudo crear el cliente Stripe',
      });
    }

    // Persistir customerId. Si todavia no hay row de subscription, fallar
    // explicito: la fila la crea el flujo de registro (Fase 1).
    if (!existing) {
      throw new NotFoundException({
        code: 'subscription_not_found',
        message: 'El tenant no tiene fila tenant_subscriptions; revisar el registro inicial',
      });
    }
    await this.admin.tenantSubscription.update({
      where: { tenantId: args.tenantId },
      data: { stripeCustomerId: customerId },
    });
    return customerId;
  }

  private async resolveTenantId(args: {
    tenantIdHint: string | null;
    stripeSubscriptionId: string;
    stripeCustomerId: string;
  }): Promise<string | null> {
    if (args.tenantIdHint) return args.tenantIdHint;
    if (args.stripeSubscriptionId) {
      const bySub = await this.admin.tenantSubscription.findUnique({
        where: { stripeSubscriptionId: args.stripeSubscriptionId },
        select: { tenantId: true },
      });
      if (bySub) return bySub.tenantId;
    }
    if (args.stripeCustomerId) {
      const byCustomer = await this.admin.tenantSubscription.findFirst({
        where: { stripeCustomerId: args.stripeCustomerId },
        select: { tenantId: true },
      });
      if (byCustomer) return byCustomer.tenantId;
    }
    return null;
  }

  private toDto(row: {
    id: string;
    tenantId: string;
    status: SubscriptionStatus;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    plan: {
      id: string;
      slug: string;
      name: string;
      priceMonthly: { toString(): string };
      features: unknown;
      stripePriceId: string | null;
      isActive: boolean;
    };
  }): TenantSubscriptionDto {
    const plan: SubscriptionPlanDto = {
      id: row.plan.id,
      slug: row.plan.slug,
      name: row.plan.name,
      description: null,
      priceMonthly: Number(row.plan.priceMonthly.toString()),
      currency: 'EUR',
      features: (row.plan.features ?? {}) as Record<string, unknown>,
      stripePriceId: row.plan.stripePriceId,
      isActive: row.plan.isActive,
    };
    return {
      id: row.id,
      tenantId: row.tenantId,
      status: row.status,
      currentPeriodStart: row.currentPeriodStart.toISOString(),
      currentPeriodEnd: row.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      stripeCustomerId: row.stripeCustomerId,
      stripeSubscriptionId: row.stripeSubscriptionId,
      plan,
    };
  }
}
