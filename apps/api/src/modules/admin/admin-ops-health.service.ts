import { Injectable } from '@nestjs/common';

import { HoldedSyncService } from '../accounting/holded-sync.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AeatCertExpiryService } from './aeat-cert-expiry.service';

import type {
  AdminBillingHealthDto,
  AdminBillingIssueInvoiceDto,
  AdminCertificateExpiringDto,
  AdminCronStatusDto,
  AdminTenantBillingHealthDto,
  AdminTenantIssueCountDto,
} from '@storageos/shared';

const HOUR_MS = 60 * 60 * 1000;
/** Pendiente de la AEAT más de esto = algo va mal. */
const AEAT_PENDING_STALE_MS = 48 * HOUR_MS;
/** Margen tras la hora prevista antes de dar una tarea por atrasada. */
const CRON_GRACE_MS = 15 * 60 * 1000;
/** Un dispositivo visto antes y sin señal desde hace más de esto está sin conexión. */
const DEVICE_OFFLINE_MS = HOUR_MS;

/** Mensaje legible de la respuesta guardada de la AEAT. */
function aeatMessage(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  for (const key of ['message', 'descripcionErrorRegistro', 'error', 'errorMessage']) {
    if (typeof r[key] === 'string' && r[key]) return (r[key] as string).slice(0, 300);
  }
  return null;
}

/**
 * Salud operativa de la plataforma para el super admin: incidencias de
 * facturación de los tenants (Veri*Factu y Holded), certificados que caducan,
 * dispositivos sin conexión y tareas programadas que no se han ejecutado.
 */
@Injectable()
export class AdminOpsHealthService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly holded: HoldedSyncService,
    private readonly certificates: AeatCertExpiryService,
  ) {}

  /** Tareas programadas: última ejecución, siguiente prevista y si va con retraso. */
  async crons(now = new Date()): Promise<AdminCronStatusDto[]> {
    const rows = await this.admin.cronHeartbeat.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => ({
      name: r.name,
      process: r.process,
      expression: r.expression,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      overdue: r.nextRunAt !== null && r.nextRunAt.getTime() < now.getTime() - CRON_GRACE_MS,
    }));
  }

  async certificatesExpiring(now = new Date()): Promise<AdminCertificateExpiringDto[]> {
    return (await this.certificates.expiring(now)).map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      tenantName: c.tenantName,
      ownerName: c.ownerName,
      validTo: c.validTo.toISOString(),
      daysLeft: c.daysLeft,
    }));
  }

  /** Tenants con facturas rechazadas/con error en la AEAT o pendientes >48 h. */
  async aeatIssues(now = new Date()): Promise<AdminTenantIssueCountDto[]> {
    const rows = await this.admin.invoice.groupBy({
      by: ['tenantId'],
      where: { deletedAt: null, ...this.aeatProblemWhere(now) },
      _count: { _all: true },
    });
    return this.withNames(rows.map((r) => ({ tenantId: r.tenantId, count: r._count._all })));
  }

  /** Tenants con Holded activo y envíos «para revisar». */
  async holdedReview(): Promise<AdminTenantIssueCountDto[]> {
    const enabled = await this.admin.holdedSettings.findMany({
      where: { enabled: true, tenant: { deletedAt: null } },
      select: { tenantId: true },
    });
    const counts = await Promise.all(
      enabled.map(async (h) => ({
        tenantId: h.tenantId,
        count: await this.holded.reviewCount(h.tenantId),
      })),
    );
    return this.withNames(counts.filter((c) => c.count > 0));
  }

  /** Cerraduras/lectores activos que se vieron alguna vez y llevan >1 h sin señal. */
  async devicesOffline(now = new Date()): Promise<AdminTenantIssueCountDto[]> {
    const rows = await this.admin.accessDevice.groupBy({
      by: ['tenantId'],
      where: {
        isActive: true,
        lastSeenAt: { not: null, lt: new Date(now.getTime() - DEVICE_OFFLINE_MS) },
        tenant: { deletedAt: null },
      },
      _count: { _all: true },
    });
    return this.withNames(rows.map((r) => ({ tenantId: r.tenantId, count: r._count._all })));
  }

  /** Página «Facturación de los tenants»: por tenant y facturas con problema. */
  async billingHealth(now = new Date()): Promise<AdminBillingHealthDto> {
    const staleBefore = new Date(now.getTime() - AEAT_PENDING_STALE_MS);
    const [byStatus, stale, holdedEnabled, certs, problemInvoices] = await Promise.all([
      this.admin.invoice.groupBy({
        by: ['tenantId', 'aeatStatus'],
        where: { deletedAt: null, aeatStatus: { in: ['rejected', 'error'] } },
        _count: { _all: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: { deletedAt: null, aeatStatus: 'pending', aeatSentAt: { lt: staleBefore } },
        _count: { _all: true },
      }),
      this.admin.holdedSettings.findMany({
        where: { enabled: true },
        select: { tenantId: true },
      }),
      this.admin.tenantAeatCredential.findMany({
        where: { revokedAt: null, ownerId: null },
        orderBy: { certValidTo: 'desc' },
        select: { tenantId: true, certValidTo: true },
      }),
      this.admin.invoice.findMany({
        where: { deletedAt: null, ...this.aeatProblemWhere(now) },
        orderBy: [{ aeatSentAt: 'desc' }],
        take: 50,
        select: {
          id: true,
          tenantId: true,
          invoiceNumber: true,
          issueDate: true,
          aeatStatus: true,
          aeatSentAt: true,
          aeatResponse: true,
          tenant: { select: { name: true } },
        },
      }),
    ]);

    const rows = new Map<
      string,
      Omit<AdminTenantBillingHealthDto, 'tenantName' | 'tenantSlug' | 'invoicingMode'>
    >();
    const row = (tenantId: string) => {
      let r = rows.get(tenantId);
      if (!r) {
        r = {
          tenantId,
          aeatRejected: 0,
          aeatError: 0,
          aeatPendingStale: 0,
          holdedEnabled: false,
          holdedReview: 0,
          certificateValidTo: null,
          certificateDaysLeft: null,
        };
        rows.set(tenantId, r);
      }
      return r;
    };
    for (const g of byStatus) {
      if (g.aeatStatus === 'rejected') row(g.tenantId).aeatRejected = g._count._all;
      if (g.aeatStatus === 'error') row(g.tenantId).aeatError = g._count._all;
    }
    for (const g of stale) row(g.tenantId).aeatPendingStale = g._count._all;
    for (const c of certs) {
      const r = row(c.tenantId);
      if (r.certificateValidTo) continue; // ya tiene el más reciente
      r.certificateValidTo = c.certValidTo.toISOString();
      r.certificateDaysLeft = Math.ceil((c.certValidTo.getTime() - now.getTime()) / (24 * HOUR_MS));
    }
    await Promise.all(
      holdedEnabled.map(async (h) => {
        const r = row(h.tenantId);
        r.holdedEnabled = true;
        r.holdedReview = await this.holded.reviewCount(h.tenantId);
      }),
    );

    const tenants = await this.admin.tenant.findMany({
      where: { id: { in: [...rows.keys()] }, deletedAt: null },
      select: { id: true, name: true, slug: true, invoicingMode: true },
    });
    const issues = (r: AdminTenantBillingHealthDto) =>
      r.aeatRejected +
      r.aeatError +
      r.aeatPendingStale +
      r.holdedReview +
      (r.certificateDaysLeft !== null && r.certificateDaysLeft <= 30 ? 1 : 0);
    const list: AdminTenantBillingHealthDto[] = tenants.map((t) => ({
      ...rows.get(t.id)!,
      tenantName: t.name,
      tenantSlug: t.slug,
      invoicingMode: t.invoicingMode,
    }));
    list.sort((a, b) => issues(b) - issues(a) || a.tenantName.localeCompare(b.tenantName));

    const invoices: AdminBillingIssueInvoiceDto[] = problemInvoices.map((i) => ({
      invoiceId: i.id,
      tenantId: i.tenantId,
      tenantName: i.tenant.name,
      invoiceNumber: i.invoiceNumber,
      issueDate: i.issueDate?.toISOString().slice(0, 10) ?? null,
      aeatStatus: i.aeatStatus ?? 'pending',
      aeatSentAt: i.aeatSentAt?.toISOString() ?? null,
      message: aeatMessage(i.aeatResponse),
    }));
    return { tenants: list, invoices };
  }

  /** Facturas con problema en la AEAT: rechazadas, con error o pendientes >48 h. */
  private aeatProblemWhere(now: Date) {
    return {
      OR: [
        { aeatStatus: { in: ['rejected' as const, 'error' as const] } },
        {
          aeatStatus: 'pending' as const,
          aeatSentAt: { lt: new Date(now.getTime() - AEAT_PENDING_STALE_MS) },
        },
      ],
    };
  }

  private async withNames(
    rows: { tenantId: string; count: number }[],
  ): Promise<AdminTenantIssueCountDto[]> {
    if (rows.length === 0) return [];
    const tenants = await this.admin.tenant.findMany({
      where: { id: { in: rows.map((r) => r.tenantId) }, deletedAt: null },
      select: { id: true, name: true },
    });
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return rows
      .filter((r) => names.has(r.tenantId))
      .map((r) => ({ tenantId: r.tenantId, tenantName: names.get(r.tenantId)!, count: r.count }))
      .sort((a, b) => b.count - a.count);
  }
}
