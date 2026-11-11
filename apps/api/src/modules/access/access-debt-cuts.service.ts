import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { accessCutUndecided } from '../../common/access-cut';
import { invoiceFacilityWhere } from '../../common/facility-scope';
import { NO_PAYMENT_IN_FLIGHT } from '../../common/sepa-remittance-guard';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { AccessCredentialsService } from './access-credentials.service';
import { AccessIntegrationsService } from './access-integrations.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type { AccessCutPendingDto, AccessCutPendingRowDto } from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

const INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  customerId: true,
  total: true,
  amountPaid: true,
  dueDate: true,
  customer: {
    select: { firstName: true, lastName: true, companyName: true, customerType: true },
  },
} as const;

/**
 * Cortes por impago que no llegaron a aplicarse. Hasta que se arregló, el
 * escalado daba por ejecutado el corte sin cortar nada: esas acciones quedaron
 * sin decidir. No se cortan de golpe al arreglarlo (el inquilino lleva tiempo
 * entrando): el equipo las ve en Deudores y decide con cada uno.
 */
@Injectable()
export class AccessDebtCutsService {
  private readonly logger = new Logger(AccessDebtCutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly credentials: AccessCredentialsService,
    private readonly integrations: AccessIntegrationsService,
  ) {}

  async pending(
    tenantId: string,
    facilityScope: string[] | null,
    facilityId?: string,
  ): Promise<AccessCutPendingDto> {
    const { mode, actions } = await this.undecided(tenantId, facilityScope, facilityId);
    const byCustomer = new Map<string, typeof actions>();
    for (const a of actions) {
      const id = a.invoice.customerId!;
      byCustomer.set(id, [...(byCustomer.get(id) ?? []), a]);
    }
    const credentials = await this.credentials.cuttableByCustomer(
      tenantId,
      [...byCustomer.keys()],
      mode === 'extras',
    );
    const now = Date.now();
    const rows: AccessCutPendingRowDto[] = [];
    for (const [customerId, own] of byCustomer) {
      const count = credentials.get(customerId) ?? 0;
      // Sin nada que cortar no hay nada que decidir.
      if (count === 0) continue;
      const customer = own[0]!.invoice.customer;
      const oldest = Math.min(...own.map((a) => (a.invoice.dueDate ?? new Date()).getTime()));
      rows.push({
        customerId,
        customerName: customer ? customerName(customer) : 'Sin identificar',
        amount: round2(
          own.reduce((s, a) => s + Number(a.invoice.total) - Number(a.invoice.amountPaid), 0),
        ),
        days: Math.max(0, Math.floor((now - oldest) / DAY)),
        invoiceIds: own.map((a) => a.invoice.id),
        invoiceNumbers: own.map((a) => a.invoice.invoiceNumber),
        credentials: count,
      });
    }
    rows.sort((a, b) => b.amount - a.amount);
    return { mode: mode === 'extras' ? 'extras' : 'all', rows };
  }

  /** Corta el acceso de un inquilino de la lista. */
  async cut(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    facilityScope: string[] | null;
    meta: RequestMeta;
  }): Promise<{ suspended: number }> {
    await this.credentials.assertCustomerAllowed(
      args.tenantId,
      args.customerId,
      args.facilityScope,
    );
    const { actions } = await this.undecided(args.tenantId, null, undefined, args.customerId);
    const first = actions[0];
    if (!first) {
      throw new NotFoundException({
        code: 'nothing_to_cut',
        message: 'Este inquilino ya no tiene nada pendiente de cortar',
      });
    }
    const outcome = await this.integrations.suspendForDunning({
      tenantId: args.tenantId,
      customerId: args.customerId,
      invoiceId: first.invoice.id,
    });
    if (!outcome.applied) {
      throw new ConflictException({
        code: 'access_cut_disabled',
        message: 'Tu negocio tiene apagado el corte de acceso por impago',
      });
    }
    await this.settle(args.tenantId, actions, {
      accessBlocked: true,
      suspended: outcome.suspended,
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'access.debt_cut_applied',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { invoiceIds: actions.map((a) => a.invoice.id), suspended: outcome.suspended },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return { suspended: outcome.suspended };
  }

  /**
   * Corta a todos los de la lista. Uno que falla (pagó entre medias, el corte
   * se apagó…) no detiene a los demás: se cuenta aparte.
   */
  async cutAll(args: {
    tenantId: string;
    userId: string;
    facilityScope: string[] | null;
    facilityId?: string;
    meta: RequestMeta;
  }): Promise<{ customers: number; suspended: number; failed: number }> {
    const { rows } = await this.pending(args.tenantId, args.facilityScope, args.facilityId);
    let suspended = 0;
    let customers = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const res = await this.cut({ ...args, customerId: row.customerId });
        suspended += res.suspended;
        customers++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `[access] corte de ${row.customerId} sin aplicar: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { customers, suspended, failed };
  }

  /** No se le corta: desaparece de la lista y sigue el escalado normal. */
  async skip(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    facilityScope: string[] | null;
    meta: RequestMeta;
  }): Promise<void> {
    await this.credentials.assertCustomerAllowed(
      args.tenantId,
      args.customerId,
      args.facilityScope,
    );
    const { actions } = await this.undecided(args.tenantId, null, undefined, args.customerId);
    if (actions.length === 0) {
      throw new NotFoundException({
        code: 'nothing_to_cut',
        message: 'Este inquilino ya no tiene nada pendiente de cortar',
      });
    }
    await this.settle(args.tenantId, actions, {
      accessBlocked: false,
      accessCutSkipped: 'staff_decision',
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'access.debt_cut_skipped',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { invoiceIds: actions.map((a) => a.invoice.id) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /**
   * Acciones sin decidir de facturas que siguen sin pagar. Quedan fuera las que
   * tienen un cobro en marcha o van en un plan de pago: el escalado tampoco las
   * cortaría.
   */
  private async undecided(
    tenantId: string,
    facilityScope: string[] | null,
    facilityId?: string,
    customerId?: string,
  ) {
    const facility = invoiceFacilityWhere(facilityScope, facilityId);
    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { accessCutMode: true },
      });
      if (!facility || tenant.accessCutMode === 'none') {
        return { mode: tenant.accessCutMode, actions: [] };
      }
      const rows = await tx.dunningAction.findMany({
        where: {
          actionType: 'access_block',
          status: 'executed',
          supersededAt: null,
          invoice: {
            ...(facility as Prisma.InvoiceWhereInput),
            customerId: customerId ?? { not: null },
            status: { in: ['issued', 'overdue'] },
            deletedAt: null,
            ...NO_PAYMENT_IN_FLIGHT,
          },
        },
        orderBy: { scheduledFor: 'asc' },
        select: {
          id: true,
          actionType: true,
          status: true,
          result: true,
          invoice: { select: INVOICE_SELECT },
        },
      });
      const open = rows.filter(accessCutUndecided);
      if (open.length === 0) return { mode: tenant.accessCutMode, actions: [] };
      const plans = await tx.paymentPlan.findMany({
        where: { status: 'active', invoiceIds: { hasSome: open.map((a) => a.invoice.id) } },
        select: { invoiceIds: true },
      });
      const inPlan = new Set(plans.flatMap((p) => p.invoiceIds));
      return {
        mode: tenant.accessCutMode,
        actions: open.filter((a) => !inPlan.has(a.invoice.id)),
      };
    }, tenantId);
  }

  private async settle(
    tenantId: string,
    actions: { id: string; result: Prisma.JsonValue }[],
    outcome: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      for (const a of actions) {
        const previous = (a.result ?? {}) as Prisma.InputJsonObject;
        await tx.dunningAction.update({
          where: { id: a.id },
          data: { result: { ...previous, ...outcome } },
        });
      }
    }, tenantId);
  }
}

function customerName(c: {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  customerType: string;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}
