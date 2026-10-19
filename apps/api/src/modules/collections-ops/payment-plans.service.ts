import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  allocateInstallments,
  buildInstallments,
  type CreatePaymentPlanInput,
  type PaymentPlanDto,
  type PaymentPlanStatus,
} from '@storageos/shared';

import { claimDailyCronRun } from '../../common/cron-claim';
import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { Prisma } from '@storageos/database';

const round2 = (n: number) => Math.round(n * 100) / 100;
const OPEN_STATUSES = ['issued', 'overdue'] as const;

type Installment = { dueDate: string; amount: number };
type PlanRow = Prisma.PaymentPlanGetPayload<{
  include: {
    customer: {
      select: { firstName: true; lastName: true; companyName: true; customerType: true };
    };
    createdBy: { select: { fullName: true } };
  };
}>;

function customerName(c: PlanRow['customer']): string {
  return c.customerType === 'business'
    ? (c.companyName ?? '—')
    : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
}

/**
 * Planes de pago: la deuda de un inquilino repartida en cuotas. El avance se
 * mide con lo cobrado de sus facturas desde que se creó el plan (cobre como
 * cobre: tarjeta, transferencia, efectivo…), aplicado a las cuotas en orden.
 * Mientras el plan está activo, el escalado de impagos y los reintentos de esas
 * facturas se pausan; si una cuota pasa del plazo de gracia, se rompe.
 */
@Injectable()
export class PaymentPlansService {
  private readonly logger = new Logger(PaymentPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    tenantId: string,
    filters: { customerId?: string; status?: string },
  ): Promise<PaymentPlanDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.paymentPlan.findMany({
        where: {
          ...(filters.customerId ? { customerId: filters.customerId } : {}),
          ...(filters.status ? { status: filters.status } : {}),
        },
        include: this.include,
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return this.toDtos(tx, rows);
    }, tenantId);
  }

  async create(
    tenantId: string,
    userId: string,
    input: CreatePaymentPlanInput,
  ): Promise<PaymentPlanDto> {
    const plan = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      const invoices = await tx.invoice.findMany({
        where: {
          customerId: input.customerId,
          deletedAt: null,
          kind: 'invoice',
          status: { in: [...OPEN_STATUSES] },
          ...(input.invoiceIds?.length ? { id: { in: input.invoiceIds } } : {}),
        },
        select: { id: true, total: true, amountPaid: true },
      });
      if (input.invoiceIds?.length && invoices.length !== input.invoiceIds.length) {
        throw new BadRequestException({
          code: 'invoice_not_payable',
          message: 'Alguna factura no es de este inquilino o ya no está pendiente.',
        });
      }
      const pending = round2(
        invoices.reduce((s, i) => s + Math.max(0, Number(i.total) - Number(i.amountPaid)), 0),
      );
      if (invoices.length === 0 || pending <= 0) {
        throw new BadRequestException({
          code: 'nothing_to_split',
          message: 'Este inquilino no tiene facturas pendientes que fraccionar.',
        });
      }
      const ids = invoices.map((i) => i.id);
      const taken = await tx.paymentPlan.findFirst({
        where: { status: 'active', invoiceIds: { hasSome: ids } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException({
          code: 'invoice_in_payment_plan',
          message: 'Alguna de estas facturas ya está en un plan de pago activo.',
        });
      }
      const installments = buildInstallments(
        pending,
        input.installmentsCount,
        input.firstDueDate,
        input.frequency,
      );
      return tx.paymentPlan.create({
        data: {
          tenantId,
          customerId: input.customerId,
          invoiceIds: ids,
          totalAmount: pending,
          paidAtStart: round2(invoices.reduce((s, i) => s + Number(i.amountPaid), 0)),
          installments,
          graceDays: input.graceDays,
          notes: input.notes ?? null,
          createdByUserId: userId,
        },
        include: this.include,
      });
    }, tenantId);

    await this.audit.write({
      tenantId,
      userId,
      action: 'payment_plan.created',
      entityType: 'PaymentPlan',
      entityId: plan.id,
      changes: {
        customerId: plan.customerId,
        totalAmount: Number(plan.totalAmount),
        installments: input.installmentsCount,
      },
    });
    if (input.notifyCustomer) await this.notifyCustomer(tenantId, plan);
    const [dto] = await this.prisma.withTenant((tx) => this.toDtos(tx, [plan]), tenantId);
    return dto!;
  }

  async cancel(tenantId: string, userId: string, id: string): Promise<PaymentPlanDto> {
    const plan = await this.prisma.withTenant(async (tx) => {
      const res = await tx.paymentPlan.updateMany({
        where: { id, status: 'active' },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      if (res.count === 0) {
        const exists = await tx.paymentPlan.findFirst({ where: { id }, select: { id: true } });
        if (!exists)
          throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
        throw new BadRequestException({
          code: 'plan_not_active',
          message: 'El plan ya no está activo.',
        });
      }
      return tx.paymentPlan.findUniqueOrThrow({ where: { id }, include: this.include });
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId,
      action: 'payment_plan.cancelled',
      entityType: 'PaymentPlan',
      entityId: id,
      changes: {},
    });
    const [dto] = await this.prisma.withTenant((tx) => this.toDtos(tx, [plan]), tenantId);
    return dto!;
  }

  @Cron('0 7 * * *', { name: 'payment-plans.daily' })
  async cron(): Promise<void> {
    if (!(await claimDailyCronRun(this.admin, 'payment-plans.daily'))) return;
    await this.evaluateAll();
  }

  /** Cierra los planes pagados y rompe los que tienen una cuota fuera de plazo. */
  async evaluateAll(now = new Date()): Promise<{ completed: number; broken: number }> {
    const plans = await this.admin.paymentPlan.findMany({
      where: { status: 'active' },
      include: this.include,
      take: 2000,
    });
    let completed = 0;
    let broken = 0;
    const today = todayInTimezone('Europe/Madrid', now).toISOString().slice(0, 10);
    for (const plan of plans) {
      const invoices = await this.admin.invoice.findMany({
        where: { id: { in: plan.invoiceIds } },
        select: { status: true, amountPaid: true },
      });
      const paid =
        invoices.reduce((s, i) => s + Number(i.amountPaid), 0) - Number(plan.paidAtStart);
      const stillOpen = invoices.some((i) =>
        (OPEN_STATUSES as readonly string[]).includes(i.status),
      );
      if (!stillOpen || paid >= Number(plan.totalAmount) - 0.005) {
        await this.admin.paymentPlan.updateMany({
          where: { id: plan.id, status: 'active' },
          data: { status: 'completed', completedAt: now },
        });
        completed++;
        continue;
      }
      const alloc = allocateInstallments(
        plan.installments as Installment[],
        paid,
        today,
        plan.graceDays,
      );
      if (alloc.some((a) => a.status === 'late')) {
        const res = await this.admin.paymentPlan.updateMany({
          where: { id: plan.id, status: 'active' },
          data: { status: 'broken', brokenAt: now },
        });
        if (res.count === 0) continue;
        broken++;
        await this.notifications
          .create(plan.tenantId, {
            type: 'payment_plan.broken',
            title: `Plan de pago incumplido — ${customerName(plan.customer)}`,
            body: 'Una cuota lleva más días sin pagarse de los acordados. El escalado de impagos sigue su curso.',
            link: `/customers/${plan.customerId}`,
          })
          .catch((err: unknown) =>
            this.logger.warn(`payment_plan.broken notify: ${(err as Error).message}`),
          );
      }
    }
    return { completed, broken };
  }

  private readonly include = {
    customer: {
      select: { firstName: true, lastName: true, companyName: true, customerType: true },
    },
    createdBy: { select: { fullName: true } },
  } as const;

  private async toDtos(tx: Prisma.TransactionClient, rows: PlanRow[]): Promise<PaymentPlanDto[]> {
    const ids = [...new Set(rows.flatMap((r) => r.invoiceIds))];
    const invoices = ids.length
      ? await tx.invoice.findMany({
          where: { id: { in: ids } },
          select: { id: true, invoiceNumber: true, amountPaid: true },
        })
      : [];
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const today = todayInTimezone().toISOString().slice(0, 10);
    return rows.map((r) => {
      const mine = r.invoiceIds.map((id) => byId.get(id)).filter((i) => !!i);
      const paid = round2(
        Math.max(0, mine.reduce((s, i) => s + Number(i.amountPaid), 0) - Number(r.paidAtStart)),
      );
      return {
        id: r.id,
        customerId: r.customerId,
        customerName: customerName(r.customer),
        status: r.status as PaymentPlanStatus,
        invoiceIds: r.invoiceIds,
        invoiceNumbers: mine.map((i) => i.invoiceNumber),
        totalAmount: Number(r.totalAmount),
        paidSoFar: paid,
        installments: allocateInstallments(
          r.installments as Installment[],
          paid,
          today,
          r.graceDays,
        ),
        graceDays: r.graceDays,
        notes: r.notes,
        createdByName: r.createdBy?.fullName ?? null,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        brokenAt: r.brokenAt?.toISOString() ?? null,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
      };
    });
  }

  private async notifyCustomer(tenantId: string, plan: PlanRow): Promise<void> {
    try {
      const c = await this.admin.customer.findUnique({
        where: { id: plan.customerId },
        select: { email: true, firstName: true, companyName: true, customerType: true },
      });
      if (!c?.email) return;
      const name = c.customerType === 'business' ? (c.companyName ?? '') : (c.firstName ?? '');
      const lines = (plan.installments as Installment[])
        .map(
          (i, k) =>
            `${k + 1}. ${formatDateLong(new Date(`${i.dueDate}T12:00:00Z`))}: ${formatEur(i.amount)}`,
        )
        .join('\n');
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: c.email,
        customerId: plan.customerId,
        source: 'payment_plan.created',
        subject: 'Tu plan de pago',
        bodyText: `Hola${name ? ` ${name}` : ''}:\n\nHemos acordado que pagues ${formatEur(Number(plan.totalAmount))} en estas cuotas:\n\n${lines}\n\nPuedes pagar cada cuota desde tu área de clientes o como lo hagas habitualmente. Mientras vayas al día, no recibirás más avisos de impago de estas facturas.\n\nGracias.`,
      });
    } catch (err) {
      this.logger.warn(`payment_plan notify customer: ${(err as Error).message}`);
    }
  }
}
