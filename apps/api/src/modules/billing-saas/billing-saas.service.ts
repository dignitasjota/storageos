import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { normalizePlanFeatures } from '@storageos/shared';
import StripeSDK from 'stripe';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { StripeGateway } from '../payments/stripe.gateway';

import { PlatformCouponsService } from './platform-coupons.service';
import { PlatformInvoicesService } from './platform-invoices.service';

import type { RequestMeta } from '../auth/auth.service';
import type { SubscriptionStatus } from '@storageos/database';
import type {
  BillingSessionResponseDto,
  SubscriptionPlanDto,
  TenantSubscriptionDto,
  TenantSubscriptionPaymentDto,
} from '@storageos/shared';

/** Mapea el `status` de una factura de Stripe a nuestro estado de pago. */
function mapInvoiceStatus(status: string | null): string {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'uncollectible':
      return 'failed';
    case 'void':
      return 'void';
    default:
      return 'pending'; // draft | open
  }
}

function unixToDate(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

/**
 * Suma `months` meses a una fecha, ajustando el desbordamiento de fin de mes
 * (31 ene + 1 mes → 28/29 feb, no 3 mar).
 */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function diffInDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Fila de `tenant_subscription_payments` → DTO. */
function toPaymentDto(r: {
  id: string;
  provider: string;
  status: string;
  amount: unknown;
  discount: unknown;
  currency: string;
  planSlug: string | null;
  planName: string | null;
  description: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  invoiceUrl: string | null;
  pdfUrl: string | null;
  createdAt: Date;
}): TenantSubscriptionPaymentDto {
  return {
    id: r.id,
    provider: r.provider,
    status: r.status,
    amount: Number(r.amount),
    discount: r.discount === null || r.discount === undefined ? null : Number(r.discount),
    currency: r.currency,
    planSlug: r.planSlug,
    planName: r.planName,
    description: r.description,
    periodStart: r.periodStart?.toISOString() ?? null,
    periodEnd: r.periodEnd?.toISOString() ?? null,
    paidAt: r.paidAt?.toISOString() ?? null,
    invoiceUrl: r.invoiceUrl,
    pdfUrl: r.pdfUrl,
    createdAt: r.createdAt.toISOString(),
  };
}

// El SDK de Stripe exporta `Stripe` como namespace y como clase con el mismo
// nombre. El import por defecto resuelve al constructor; para acceder a los
// tipos anidados (Stripe.Checkout.Session, Stripe.BillingPortal.Session)
// usamos los tipos inferidos del cliente. Patron alineado con
// `stripe.gateway.ts`.
type StripeClient = InstanceType<typeof StripeSDK>;
type StripeInvoice = Awaited<ReturnType<StripeClient['invoices']['list']>>['data'][number];
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
    private readonly platformInvoices: PlatformInvoicesService,
    private readonly coupons: PlatformCouponsService,
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
    const [tenant, plan, currentSub] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: args.tenantId } }),
      this.admin.subscriptionPlan.findUnique({ where: { id: args.planId } }),
      this.admin.tenantSubscription.findUnique({
        where: { tenantId: args.tenantId },
        select: { stripeSubscriptionId: true, status: true },
      }),
    ]);
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    // Evita crear una segunda suscripción Stripe (doble cobro): si ya hay una
    // viva, el cambio de plan va por `changePlan`, no por un checkout nuevo.
    if (currentSub?.stripeSubscriptionId && currentSub.status === 'active') {
      throw new BadRequestException({
        code: 'already_subscribed',
        message: 'Ya tienes una suscripción activa. Usa «Cambiar de plan» para cambiarla.',
      });
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
   * Cambio de plan self-service (upgrade/downgrade) del propio tenant. Si tiene
   * suscripción Stripe, actualiza el price item existente con proration (Stripe
   * cobra/acredita la diferencia); NO crea una suscripción nueva. Actualiza el
   * `planId` en BD directamente (el webhook `subscription.updated` no trae el
   * plan). Un tenant de pago manual no puede cambiar solo → contacta con soporte.
   */
  async changePlanSelfService(args: {
    tenantId: string;
    userId: string;
    planId: string;
    meta: RequestMeta;
  }): Promise<TenantSubscriptionDto> {
    const [sub, plan] = await Promise.all([
      this.admin.tenantSubscription.findUnique({ where: { tenantId: args.tenantId } }),
      this.admin.subscriptionPlan.findUnique({ where: { id: args.planId } }),
    ]);
    if (!sub) {
      throw new NotFoundException({ code: 'no_subscription', message: 'Sin suscripción' });
    }
    if (!plan || !plan.isActive) {
      throw new BadRequestException({ code: 'plan_not_available', message: 'Plan no disponible' });
    }
    if (plan.id === sub.planId) {
      throw new BadRequestException({ code: 'already_on_plan', message: 'Ya estás en ese plan' });
    }
    if (!sub.stripeSubscriptionId) {
      throw new BadRequestException({
        code: 'manual_plan_change',
        message: 'Tu suscripción es de pago manual. Contacta con soporte para cambiar de plan.',
      });
    }
    if (!plan.stripePriceId) {
      throw new BadRequestException({
        code: 'plan_not_available',
        message: 'El plan no tiene un precio configurado en Stripe',
      });
    }

    const previousPlanId = sub.planId;
    // Precio de Stripe del plan ACTUAL: identifica cuál de los subscription items
    // es el del plan (no un add-on) para intercambiar SOLO ese. Con add-ons en
    // modo Stripe hay varios items; `items.data[0]` ya no es necesariamente el plan.
    const currentPlan = await this.admin.subscriptionPlan.findUnique({
      where: { id: sub.planId },
      select: { stripePriceId: true },
    });
    try {
      const stripeSub = await this.stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
      const items = stripeSub.items.data;
      // El item del plan = el que casa con el price del plan actual; si no se
      // resuelve, el que NO es un add-on (metadata.kind !== 'addon'); último recurso, el primero.
      const planItem =
        (currentPlan?.stripePriceId
          ? items.find((i) => i.price?.id === currentPlan.stripePriceId)
          : undefined) ??
        items.find((i) => i.metadata?.kind !== 'addon') ??
        items[0];
      const itemId = planItem?.id;
      if (!itemId) {
        throw new InternalServerErrorException({
          code: 'stripe_api_error',
          message: 'La suscripción de Stripe no tiene líneas',
        });
      }
      await this.stripe.subscriptions.update(sub.stripeSubscriptionId, {
        items: [{ id: itemId, price: plan.stripePriceId }],
        proration_behavior: 'create_prorations',
      });
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(
        `Stripe subscriptions.update falló para tenant ${args.tenantId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException({
        code: 'stripe_api_error',
        message: 'No se pudo cambiar el plan en Stripe',
      });
    }

    // El webhook `subscription.updated` no trae el planId → lo fijamos aquí.
    await this.admin.tenantSubscription.update({
      where: { tenantId: args.tenantId },
      data: { planId: plan.id },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'saas_billing.plan_changed',
      entityType: 'TenantSubscription',
      entityId: sub.id,
      changes: { from: previousPlanId, to: plan.id, self: true },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.getCurrentSubscription(args.tenantId);
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
      // Divergencia Stripe↔BD: alerta al super admin (best-effort) en vez de
      // fallar en silencio (Stripe recibe 200 y no reintenta).
      await this.admin.superAdminNotification
        .create({
          data: {
            type: 'saas_billing.unresolved_webhook',
            title: 'Webhook de facturación sin tenant',
            body: `No se pudo resolver el tenant de un webhook de Stripe (sub ${args.stripeSubscriptionId}, customer ${args.stripeCustomerId}). Revisa la suscripción manualmente.`,
            link: '/admin/tenants',
          },
        })
        .catch(() => undefined);
      return;
    }

    const newStatus = mapStripeStatus(args.status);
    const periodStart = new Date(args.currentPeriodStart * 1000);
    const stripePeriodEnd = new Date(args.currentPeriodEnd * 1000);

    // El crédito de pagos manuales (acumulador permanente) se SUMA al periodo
    // que dicta Stripe: el periodo efectivo = fecha de Stripe + días manuales.
    // Así un pago manual no se pisa con el siguiente cobro de Stripe.
    const current = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: { manualExtensionDays: true },
    });
    const manualDays = current?.manualExtensionDays ?? 0;
    const periodEnd = manualDays > 0 ? addDays(stripePeriodEnd, manualDays) : stripePeriodEnd;

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

    // Si Stripe reporta la suscripción activa (el tenant se suscribió y pagó),
    // el tenant pasa a `active`: sale del dunning (`suspended`) Y del periodo de
    // prueba (`trial`) — al pagar de verdad ya no es un trial.
    if (newStatus === 'active') {
      await this.admin.tenant.updateMany({
        where: { id: tenantId, status: { in: ['suspended', 'trial'] } },
        data: { status: 'active' },
      });
    }

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
  async recordInvoicePaymentFailed(invoice: StripeInvoice): Promise<void> {
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const tenantId = await this.resolveTenantId({
      tenantIdHint: invoice.metadata?.tenantId ?? null,
      stripeSubscriptionId: '',
      stripeCustomerId: customerId ?? '',
    });
    if (!tenantId) {
      this.logger.warn(`invoice.payment_failed sin tenant resoluble (invoice=${invoice.id})`);
      return;
    }

    // Persistimos el fallo (upsert por external_id) con el contador de intentos:
    // así el «retry analysis» puede medir la tasa de recuperación. Al cobrarse
    // luego, `recordStripeInvoice` marca `recoveredAt` sobre esta misma fila.
    const externalId = invoice.id ?? null;
    const line = invoice.lines?.data?.[0];
    const amountCents = invoice.amount_due || invoice.total || 0;
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { slug: true, name: true } } },
    });
    const existing = externalId
      ? await this.admin.tenantSubscriptionPayment.findFirst({
          where: { provider: 'stripe', externalId },
          select: { id: true, firstFailedAt: true, failedAttempts: true },
        })
      : null;
    if (existing) {
      await this.admin.tenantSubscriptionPayment.update({
        where: { id: existing.id },
        data: {
          status: 'failed',
          failedAttempts: existing.failedAttempts + 1,
          firstFailedAt: existing.firstFailedAt ?? new Date(),
          recoveredAt: null,
        },
      });
    } else {
      await this.admin.tenantSubscriptionPayment.create({
        data: {
          tenantId,
          provider: 'stripe',
          externalId,
          status: 'failed',
          failedAttempts: 1,
          firstFailedAt: new Date(),
          amount: amountCents / 100,
          currency: (invoice.currency ?? 'eur').toUpperCase(),
          planSlug: sub?.plan?.slug ?? null,
          planName: sub?.plan?.name ?? null,
          periodStart: unixToDate(line?.period?.start) ?? unixToDate(invoice.period_start),
          periodEnd: unixToDate(line?.period?.end) ?? unixToDate(invoice.period_end),
        },
      });
    }

    await this.audit.write({
      tenantId,
      userId: null,
      action: 'saas_billing.invoice_payment_failed',
      entityType: 'TenantSubscription',
      entityId: null,
      changes: {
        stripeCustomerId: customerId ?? null,
        ...(externalId ? { invoiceId: externalId } : {}),
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
      tenantFeatures?: string[];
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
      priceYearly: 0,
      currency: 'EUR',
      features: (row.plan.features ?? {}) as Record<string, unknown>,
      tenantFeatures: normalizePlanFeatures(row.plan.tenantFeatures),
      stripePriceId: row.plan.stripePriceId,
      maxUnits: null,
      maxFacilities: null,
      maxUsers: null,
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

  // ==========================================================================
  // Historial de pagos de la suscripción SaaS (persistido en BD)
  // ==========================================================================

  /** Lista los pagos SaaS guardados de un tenant (panel super admin). */
  async listSaasPayments(tenantId: string): Promise<TenantSubscriptionPaymentDto[]> {
    const rows = await this.admin.tenantSubscriptionPayment.findMany({
      where: { tenantId },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => toPaymentDto(r));
  }

  /**
   * Registra un pago MANUAL de la suscripción (efectivo/transferencia/PayPal/…)
   * y **extiende el periodo** de la suscripción `durationMonths` meses, igual
   * que un cobro de Stripe: a todos los efectos, un pago más.
   *
   * La base de la extensión es `max(currentPeriodEnd, ahora)` para no regalar
   * ni perder días si el periodo aún no había vencido. Deja la suscripción en
   * `active`. Todo en una transacción (pago + extensión atómicos).
   */
  async recordManualPayment(args: {
    tenantId: string;
    provider: string;
    amount: number;
    discount?: number | null | undefined;
    currency: string;
    durationMonths: number;
    /**
     * `true` (default): pago de la suscripción → extiende el periodo (y acumula
     * el crédito para no pisarse con Stripe). `false`: cobro puntual (p. ej. un
     * add-on cobrado en mano de un tenant que paga el plan por Stripe) → NO
     * toca el periodo; solo registra el ingreso + factura.
     */
    extendsPeriod?: boolean;
    paidAt?: Date | null | undefined;
    description?: string | null | undefined;
    /**
     * Código de cupón de plataforma opcional. Si viene, el descuento se calcula
     * en el servidor (no se confía en `args.discount`) y el uso del cupón se
     * incrementa de forma atómica al materializar el pago.
     */
    couponCode?: string | null | undefined;
  }): Promise<TenantSubscriptionPaymentDto> {
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId: args.tenantId },
      include: { plan: { select: { slug: true, name: true } } },
    });
    if (!sub) {
      throw new NotFoundException({
        code: 'subscription_not_found',
        message: 'El tenant no tiene una suscripción.',
      });
    }

    // Cupón de plataforma: valida y calcula el descuento server-side. NO se
    // confía en `args.discount` cuando hay cupón; el cupón manda. El uso se
    // incrementa más abajo, tras el guard de dedup (para no consumirlo en un
    // doble-submit que devuelve el pago existente).
    let couponId: string | null = null;
    let discount = args.discount ?? null;
    if (args.couponCode) {
      const res = await this.coupons.validateAndComputeDiscount(args.couponCode, args.amount);
      couponId = res.couponId;
      discount = res.discount;
    }

    // Idempotencia anti-doble-submit: registrar un pago manual extiende el
    // periodo e incrementa `manualExtensionDays`; un doble clic o reintento de
    // red lo aplicaría DOS veces (periodo extendido de más, ingreso duplicado).
    // Si ya hay un pago idéntico (mismo provider+importe) en los últimos 60s, lo
    // devolvemos en vez de duplicar.
    const dedupeWindow = new Date(Date.now() - 60_000);
    const recent = await this.admin.tenantSubscriptionPayment.findFirst({
      where: {
        tenantId: args.tenantId,
        provider: args.provider,
        amount: args.amount,
        status: 'paid',
        createdAt: { gte: dedupeWindow },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return toPaymentDto(recent);

    // Consumimos el cupón (uso atómico) justo antes de crear el pago: pasada la
    // dedup, ya vamos a materializar. Si otra petición lo agotó en la carrera,
    // lanza 400 `coupon_exhausted` y no se registra el pago.
    if (couponId) await this.coupons.incrementUsage(couponId);

    const now = new Date();
    const extendsPeriod = args.extendsPeriod !== false;

    // Cobro puntual (add-on) que NO extiende el periodo: registra el pago sobre
    // el periodo VIGENTE, sin tocar la suscripción (el periodo lo lleva Stripe).
    if (!extendsPeriod) {
      const payment = await this.admin.tenantSubscriptionPayment.create({
        data: {
          tenantId: args.tenantId,
          provider: args.provider,
          externalId: null,
          status: 'paid',
          amount: args.amount,
          discount,
          currency: args.currency,
          planSlug: sub.plan.slug,
          planName: sub.plan.name,
          description: args.description ?? null,
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
          paidAt: args.paidAt ?? now,
        },
      });
      await this.platformInvoices.issueForPaymentBestEffort(payment.id);
      return toPaymentDto(payment);
    }

    const base = sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
    const newEnd = addMonths(base, args.durationMonths);
    // Días de crédito que aporta este pago. El acumulador SOLO tiene sentido si
    // el tenant también cobra por Stripe (para que el webhook SUME este tiempo en
    // vez de pisarlo). Para un tenant SIN Stripe, `currentPeriodEnd` es la verdad
    // absoluta (no hay webhook que lo pise) → NO se acumula, o al vincularse a
    // Stripe más tarde se le regalaría el tiempo ya consumido.
    const accrues = sub.stripeSubscriptionId != null;
    const addedDays = accrues ? diffInDays(base, newEnd) : 0;

    const [payment] = await this.admin.$transaction([
      this.admin.tenantSubscriptionPayment.create({
        data: {
          tenantId: args.tenantId,
          provider: args.provider,
          externalId: null,
          status: 'paid',
          amount: args.amount,
          discount,
          currency: args.currency,
          planSlug: sub.plan.slug,
          planName: sub.plan.name,
          description: args.description ?? null,
          periodStart: base,
          periodEnd: newEnd,
          paidAt: args.paidAt ?? now,
        },
      }),
      this.admin.tenantSubscription.update({
        where: { tenantId: args.tenantId },
        data: {
          currentPeriodEnd: newEnd,
          status: 'active',
          manualExtensionDays: { increment: addedDays },
        },
      }),
      // Un pago de suscripción activa el tenant: sale del periodo de prueba
      // (`trial`, ya está pagando) o del dunning (`suspended`, pago regularizado).
      // El filtro por estado no toca `active` ni `cancelled` (una baja no revive
      // por un cobro retroactivo).
      this.admin.tenant.updateMany({
        where: { id: args.tenantId, status: { in: ['suspended', 'trial'] } },
        data: { status: 'active' },
      }),
    ]);

    // Factura del SaaS (best-effort; solo si la facturación está activada).
    await this.platformInvoices.issueForPaymentBestEffort(payment.id);

    return toPaymentDto(payment);
  }

  /**
   * Backfill: trae las facturas del cliente en Stripe y las registra
   * (idempotente). No lanza si Stripe no está configurado o el tenant no tiene
   * `stripeCustomerId` (devuelve `{ synced: 0 }`).
   */
  async syncSaasPaymentsFromStripe(tenantId: string): Promise<{ synced: number }> {
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { slug: true, name: true } } },
    });
    if (!sub?.stripeCustomerId) return { synced: 0 };

    let synced = 0;
    try {
      const invoices = await this.stripe.invoices.list({
        customer: sub.stripeCustomerId,
        limit: 100,
      });
      for (const inv of invoices.data) {
        await this.recordStripeInvoice(tenantId, inv, sub.plan);
        synced += 1;
      }
    } catch (err) {
      this.logger.warn(
        `Sync de pagos SaaS desde Stripe falló (tenant=${tenantId}): ${String(err)}`,
      );
    }
    return { synced };
  }

  /** Registra (upsert) un pago desde un webhook de Stripe; resuelve el tenant. */
  async recordStripeInvoiceFromWebhook(invoice: StripeInvoice): Promise<void> {
    // En Stripe SDK v22 `invoice.subscription` ya no está tipado en la factura;
    // resolvemos el tenant por el cliente (único por tenant), que sí está.
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const tenantId = await this.resolveTenantId({
      tenantIdHint: null,
      stripeSubscriptionId: '',
      stripeCustomerId: customerId ?? '',
    });
    if (!tenantId) {
      this.logger.warn(`Pago SaaS de Stripe sin tenant resoluble (invoice=${invoice.id})`);
      return;
    }
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { slug: true, name: true } } },
    });
    await this.recordStripeInvoice(tenantId, invoice, sub?.plan ?? null);
  }

  /** Upsert idempotente (por external_id) de una factura de Stripe en BD. */
  private async recordStripeInvoice(
    tenantId: string,
    invoice: StripeInvoice,
    planHint?: { slug: string; name: string } | null,
  ): Promise<void> {
    const externalId = invoice.id;
    const line = invoice.lines?.data?.[0];
    const amountCents = invoice.amount_paid || invoice.amount_due || invoice.total || 0;
    const data = {
      tenantId,
      provider: 'stripe',
      externalId,
      status: mapInvoiceStatus(invoice.status),
      amount: amountCents / 100,
      currency: (invoice.currency ?? 'eur').toUpperCase(),
      planSlug: planHint?.slug ?? null,
      planName: planHint?.name ?? null,
      description: line?.description ?? invoice.description ?? null,
      periodStart: unixToDate(line?.period?.start) ?? unixToDate(invoice.period_start),
      periodEnd: unixToDate(line?.period?.end) ?? unixToDate(invoice.period_end),
      paidAt: unixToDate(invoice.status_transitions?.paid_at),
      invoiceUrl: invoice.hosted_invoice_url ?? null,
      pdfUrl: invoice.invoice_pdf ?? null,
    };

    const existing = await this.admin.tenantSubscriptionPayment.findFirst({
      where: { provider: 'stripe', externalId },
      select: { id: true, firstFailedAt: true, recoveredAt: true },
    });
    if (existing) {
      // Si esta factura había fallado antes y ahora se cobra, marca la
      // recuperación (para el retry analysis).
      const recovered =
        data.status === 'paid' && existing.firstFailedAt && !existing.recoveredAt
          ? { recoveredAt: new Date() }
          : {};
      await this.admin.tenantSubscriptionPayment.update({
        where: { id: existing.id },
        data: { ...data, ...recovered },
      });
      return;
    }
    try {
      const created = await this.admin.tenantSubscriptionPayment.create({ data });
      // Factura del SaaS si el pago llegó cobrado (best-effort).
      if (created.status === 'paid') {
        await this.platformInvoices.issueForPaymentBestEffort(created.id);
      }
    } catch (err) {
      // Race con el índice único parcial: ya existe, lo ignoramos.
      this.logger.debug(`recordStripeInvoice create race (invoice=${externalId}): ${String(err)}`);
    }
  }
}
