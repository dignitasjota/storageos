import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import type {
  ApplicationFeeReportDto,
  PlatformPaymentSettingsDto,
  TenantApplicationFeeDto,
  UpdatePlatformPaymentSettingsInput,
} from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Comisión de la plataforma sobre los cobros de Stripe de los tenants. */
@Injectable()
export class PlatformPaymentSettingsService {
  constructor(private readonly admin: PrismaAdminService) {}

  private async row() {
    return (
      (await this.admin.platformPaymentSettings.findFirst()) ??
      (await this.admin.platformPaymentSettings.create({ data: {} }))
    );
  }

  async applicationFeePct(): Promise<number> {
    return Number((await this.row()).applicationFeePct);
  }

  /** Comisión que se aplica a un tenant: la suya si la tiene, si no la general. */
  async applicationFeePctFor(tenantId: string): Promise<number> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { applicationFeePct: true },
    });
    return tenant?.applicationFeePct != null
      ? Number(tenant.applicationFeePct)
      : this.applicationFeePct();
  }

  /** Tenants con una comisión propia. */
  async listTenantFees(): Promise<TenantApplicationFeeDto[]> {
    const rows = await this.admin.tenant.findMany({
      where: { applicationFeePct: { not: null }, deletedAt: null },
      select: { id: true, name: true, slug: true, applicationFeePct: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      tenantId: r.id,
      tenantName: r.name,
      tenantSlug: r.slug,
      applicationFeePct: Number(r.applicationFeePct),
    }));
  }

  /** Fija o quita (null) la comisión propia de un tenant. */
  async setTenantFee(tenantId: string, pct: number | null): Promise<TenantApplicationFeeDto[]> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    await this.admin.tenant.update({ where: { id: tenantId }, data: { applicationFeePct: pct } });
    return this.listTenantFees();
  }

  /**
   * Comisión cobrada en los cobros con tarjeta de los tenants (Stripe Connect)
   * por mes, en hora de España, y los tenants que más han dejado.
   */
  async feeReport(months = 12): Promise<ApplicationFeeReportDto> {
    const n = Math.min(Math.max(Math.trunc(months) || 12, 1), 36);
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - (n - 1), 1);
    since.setUTCHours(0, 0, 0, 0);
    const [byMonth, byTenant] = await Promise.all([
      this.admin.$queryRaw<{ month: string; fee: number; charges: number }[]>`
        SELECT to_char(timezone('Europe/Madrid', paid_at), 'YYYY-MM') AS month,
               COALESCE(SUM(application_fee_amount), 0)::float AS fee,
               COUNT(*)::int AS charges
        FROM payments
        WHERE application_fee_amount IS NOT NULL
          AND status IN ('succeeded', 'partially_refunded')
          AND paid_at >= ${since}
        GROUP BY 1 ORDER BY 1`,
      this.admin.$queryRaw<{ tenant_id: string; name: string; fee: number }[]>`
        SELECT p.tenant_id, t.name, COALESCE(SUM(p.application_fee_amount), 0)::float AS fee
        FROM payments p JOIN tenants t ON t.id = p.tenant_id
        WHERE p.application_fee_amount IS NOT NULL
          AND p.status IN ('succeeded', 'partially_refunded')
          AND p.paid_at >= ${since}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
    ]);
    const found = new Map(byMonth.map((m) => [m.month, m]));
    const list: ApplicationFeeReportDto['months'] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(since);
      d.setUTCMonth(since.getUTCMonth() + i);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const m = found.get(key);
      list.push({ month: key, fee: round2(m?.fee ?? 0), charges: m?.charges ?? 0 });
    }
    return {
      months: list,
      topTenants: byTenant.map((t) => ({
        tenantId: t.tenant_id,
        tenantName: t.name,
        fee: round2(t.fee),
      })),
      total: round2(list.reduce((s, m) => s + m.fee, 0)),
    };
  }

  async get(): Promise<PlatformPaymentSettingsDto> {
    const [row, connectedTenants] = await Promise.all([
      this.row(),
      this.admin.tenantStripeAccount.count({ where: { chargesEnabled: true } }),
    ]);
    return { applicationFeePct: Number(row.applicationFeePct), connectedTenants };
  }

  async update(input: UpdatePlatformPaymentSettingsInput): Promise<PlatformPaymentSettingsDto> {
    const row = await this.row();
    await this.admin.platformPaymentSettings.update({
      where: { id: row.id },
      data: { applicationFeePct: input.applicationFeePct },
    });
    return this.get();
  }
}
