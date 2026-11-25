import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TtlCache } from '../../common/cache/ttl-cache';
import { HoldedSyncService } from '../accounting/holded-sync.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AeatCertExpiryService } from './aeat-cert-expiry.service';
import {
  aeatProblemWhere,
  failingEmitters,
  liveVerifactuTenantWhere,
  staleBefore,
  unsentRecordWhere,
} from './aeat-problems';

import type { Env } from '../../config/env.schema';
import type {
  AdminBillingHealthDto,
  AdminBillingIssueInvoiceDto,
  AdminCertificateExpiringDto,
  AdminCronStatusDto,
  AdminOwnerCertificateDto,
  AdminTenantBillingHealthDto,
  AdminTenantIssueCountDto,
} from '@storageos/shared';

const HOUR_MS = 60 * 60 * 1000;
/** Margen tras la hora prevista antes de dar una tarea por atrasada. */
const CRON_GRACE_MS = 15 * 60 * 1000;
/** Un dispositivo visto antes y sin señal desde hace más de esto está sin conexión. */
const DEVICE_OFFLINE_MS = HOUR_MS;
/** Los envíos enteros fallidos se enseñan durante este plazo. */
const FAILED_SUBMISSION_DAYS = 7;
/** La lista de facturas con problema trae las más recientes. */
const PROBLEM_INVOICES_LIMIT = 50;

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
  private readonly holdedCache = new TtlCache<AdminTenantIssueCountDto[]>(
    process.env.NODE_ENV === 'test' ? 0 : 5 * 60_000,
  );

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly holded: HoldedSyncService,
    private readonly certificates: AeatCertExpiryService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Modo del envío a la AEAT de la plataforma. */
  private aeatMode(): 'stub' | 'sandbox' | 'production' {
    return this.config.get('AEAT_MODE', { infer: true });
  }

  async removeCron(name: string): Promise<{ removed: number }> {
    const { count } = await this.admin.cronHeartbeat.deleteMany({ where: { name } });
    return { removed: count };
  }

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

  /**
   * Tenants con facturas rechazadas, con error o aceptadas con errores en la
   * AEAT, pendientes de respuesta >48 h o sin enviar, y los que tienen Veri*Factu
   * real activo sin certificado.
   */
  async aeatIssues(now = new Date()): Promise<AdminTenantIssueCountDto[]> {
    const before = staleBefore(now);
    const failing = await failingEmitters(this.admin);
    const rows = await this.admin.invoice.groupBy({
      by: ['tenantId'],
      where: aeatProblemWhere(before, failing),
      _count: { _all: true },
    });
    const counts = new Map(rows.map((r) => [r.tenantId, r._count._all]));
    for (const id of await this.tenantsWithoutCertificate()) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return this.withNames([...counts].map(([tenantId, count]) => ({ tenantId, count })));
  }

  /**
   * Negocios con Veri*Factu activado, envío real (pruebas o producción) y sin
   * certificado vigente propio (ninguno o revocado). Los que emiten en Holded no
   * lo necesitan.
   */
  private async tenantsWithoutCertificate(): Promise<string[]> {
    if (this.aeatMode() === 'stub') return [];
    const tenants = await this.admin.tenant.findMany({
      where: {
        ...liveVerifactuTenantWhere(),
        invoicingMode: 'app',
        aeatCredentials: { none: { revokedAt: null, ownerId: null } },
      },
      select: { id: true },
    });
    return tenants.map((t) => t.id);
  }

  /** Tenants con Holded activo y envíos «para revisar». */
  async holdedReview(): Promise<AdminTenantIssueCountDto[]> {
    // Una consulta por tenant con Holded: no hace falta repetirla cada minuto.
    return this.holdedCache.get('all', () => this.computeHoldedReview());
  }

  private async computeHoldedReview(): Promise<AdminTenantIssueCountDto[]> {
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
        // Los simulados (cuenta de demostración, pruebas) nunca dan señal.
        OR: [{ provider: null }, { provider: { not: 'stub' } }],
        lastSeenAt: { not: null, lt: new Date(now.getTime() - DEVICE_OFFLINE_MS) },
        tenant: { deletedAt: null, status: { in: ['active', 'trial'] } },
      },
      _count: { _all: true },
    });
    return this.withNames(rows.map((r) => ({ tenantId: r.tenantId, count: r._count._all })));
  }

  /** Página «Problemas de facturación»: por tenant y facturas con problema. */
  async billingHealth(now = new Date()): Promise<AdminBillingHealthDto> {
    const before = staleBefore(now);
    const failedSince = new Date(now.getTime() - FAILED_SUBMISSION_DAYS * 24 * HOUR_MS);
    const realMode = this.aeatMode() !== 'stub';
    const failing = await failingEmitters(this.admin);
    const tenantWhere = liveVerifactuTenantWhere();
    const problemWhere = aeatProblemWhere(before, failing);

    const [
      byStatus,
      stale,
      unsent,
      emitters,
      holdedEnabled,
      certs,
      problemInvoices,
      invoicesTotal,
      failedSubmissions,
      acceptedSubmissions,
    ] = await Promise.all([
      this.admin.invoice.groupBy({
        by: ['tenantId', 'aeatStatus'],
        where: {
          deletedAt: null,
          tenant: tenantWhere,
          aeatStatus: { in: ['rejected', 'error', 'accepted_with_warnings'] },
        },
        _count: { _all: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: {
          deletedAt: null,
          tenant: tenantWhere,
          aeatStatus: 'pending',
          aeatSentAt: { lt: before },
        },
        _count: { _all: true },
      }),
      this.admin.verifactuRecord.groupBy({
        by: ['tenantId', 'ownerId'],
        where: unsentRecordWhere(before, failing),
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      this.admin.verifactuEmitter.findMany({
        where: { tenant: tenantWhere, consecutiveFailures: { gt: 0 } },
        select: { tenantId: true, ownerId: true, lastError: true, consecutiveFailures: true },
      }),
      this.admin.holdedSettings.findMany({
        where: { enabled: true },
        select: { tenantId: true },
      }),
      this.admin.tenantAeatCredential.findMany({
        where: { revokedAt: null },
        orderBy: { certValidTo: 'desc' },
        select: {
          tenantId: true,
          ownerId: true,
          certValidTo: true,
          owner: { select: { legalName: true } },
        },
      }),
      this.admin.invoice.findMany({
        where: problemWhere,
        orderBy: [{ aeatSentAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: PROBLEM_INVOICES_LIMIT,
        select: {
          id: true,
          tenantId: true,
          invoiceNumber: true,
          issueDate: true,
          aeatStatus: true,
          aeatSentAt: true,
          aeatResponse: true,
          ownerId: true,
          tenant: { select: { name: true } },
        },
      }),
      this.admin.invoice.count({ where: problemWhere }),
      this.admin.verifactuSubmission.findMany({
        where: {
          sentAt: { gte: failedSince },
          status: { in: ['error', 'rejected'] },
          tenant: tenantWhere,
        },
        orderBy: { sentAt: 'desc' },
        select: { tenantId: true, ownerId: true, status: true, message: true, sentAt: true },
      }),
      this.admin.verifactuSubmission.groupBy({
        by: ['tenantId', 'ownerId'],
        where: { status: { in: ['accepted', 'partially_accepted'] }, tenant: tenantWhere },
        _max: { sentAt: true },
      }),
    ]);

    const rows = new Map<
      string,
      Omit<AdminTenantBillingHealthDto, 'tenantName' | 'tenantSlug' | 'invoicingMode' | 'issues'>
    >();
    const row = (tenantId: string) => {
      let r = rows.get(tenantId);
      if (!r) {
        r = {
          tenantId,
          verifactuEnabled: false,
          aeatRejected: 0,
          aeatError: 0,
          aeatWarnings: 0,
          aeatPendingStale: 0,
          unsentRecords: 0,
          unsentSince: null,
          unsentLastError: null,
          failedSubmissions: 0,
          lastSubmissionError: null,
          lastSubmissionAt: null,
          lastSentAt: null,
          holdedEnabled: false,
          holdedReview: 0,
          certificateValidTo: null,
          certificateDaysLeft: null,
          certificateMissing: false,
          ownerCertificates: [],
        };
        rows.set(tenantId, r);
      }
      return r;
    };
    for (const g of byStatus) {
      if (g.aeatStatus === 'rejected') row(g.tenantId).aeatRejected = g._count._all;
      if (g.aeatStatus === 'error') row(g.tenantId).aeatError = g._count._all;
      if (g.aeatStatus === 'accepted_with_warnings') row(g.tenantId).aeatWarnings = g._count._all;
    }
    for (const g of stale) row(g.tenantId).aeatPendingStale = g._count._all;

    // Registros sin enviar: cuántos, desde cuándo y el último error del emisor.
    const emitterOf = (tenantId: string, ownerId: string | null) =>
      emitters.find((e) => e.tenantId === tenantId && e.ownerId === ownerId);
    for (const g of unsent) {
      const r = row(g.tenantId);
      r.unsentRecords += g._count._all;
      const since = g._min.createdAt;
      if (since && (!r.unsentSince || since.toISOString() < r.unsentSince)) {
        r.unsentSince = since.toISOString();
      }
      r.unsentLastError ??= emitterOf(g.tenantId, g.ownerId)?.lastError?.slice(0, 300) ?? null;
    }

    // Envíos enteros fallidos o rechazados que no tienen uno correcto después.
    const lastAccepted = new Map<string, Date>();
    for (const a of acceptedSubmissions) {
      if (a._max.sentAt) lastAccepted.set(`${a.tenantId}:${a.ownerId ?? ''}`, a._max.sentAt);
      const r = row(a.tenantId);
      const iso = a._max.sentAt?.toISOString() ?? null;
      if (iso && (!r.lastSentAt || iso > r.lastSentAt)) r.lastSentAt = iso;
    }
    for (const f of failedSubmissions) {
      const ok = lastAccepted.get(`${f.tenantId}:${f.ownerId ?? ''}`);
      if (ok && ok >= f.sentAt) continue;
      const r = row(f.tenantId);
      r.failedSubmissions += 1;
      // Vienen de más reciente a más antiguo: el primero es el último.
      r.lastSubmissionError ??= f.message?.slice(0, 300) ?? null;
      r.lastSubmissionAt ??= f.sentAt.toISOString();
    }

    for (const c of certs) {
      const daysLeft = Math.ceil((c.certValidTo.getTime() - now.getTime()) / (24 * HOUR_MS));
      if (c.ownerId) {
        row(c.tenantId).ownerCertificates.push({
          ownerName: c.owner?.legalName ?? null,
          validTo: c.certValidTo.toISOString(),
          daysLeft,
        } satisfies AdminOwnerCertificateDto);
        continue;
      }
      const r = row(c.tenantId);
      if (r.certificateValidTo) continue; // ya tiene el más reciente
      r.certificateValidTo = c.certValidTo.toISOString();
      r.certificateDaysLeft = daysLeft;
    }
    await Promise.all(
      holdedEnabled.map(async (h) => {
        const r = row(h.tenantId);
        r.holdedEnabled = true;
        r.holdedReview = await this.holded.reviewCount(h.tenantId);
      }),
    );

    // Todos los negocios con Veri*Factu activado salen, tengan o no problemas
    // (con «Solo con problemas» se filtra en pantalla).
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        status: { not: 'cancelled' },
        OR: [{ id: { in: [...rows.keys()] } }, { verifactuEnabled: true }],
      },
      select: { id: true, name: true, slug: true, invoicingMode: true, verifactuEnabled: true },
    });
    const list: AdminTenantBillingHealthDto[] = tenants.map((t) => {
      const r = row(t.id);
      r.verifactuEnabled = t.verifactuEnabled;
      const holdedMode = t.invoicingMode === 'holded';
      // Quien emite en Holded no usa certificado en la app.
      if (holdedMode) {
        r.certificateValidTo = null;
        r.certificateDaysLeft = null;
        r.ownerCertificates = [];
      }
      r.certificateMissing =
        realMode && t.verifactuEnabled && !holdedMode && r.certificateValidTo === null;
      const issues =
        r.aeatRejected +
        r.aeatError +
        r.aeatWarnings +
        r.aeatPendingStale +
        r.unsentRecords +
        r.failedSubmissions +
        r.holdedReview +
        (r.certificateMissing ? 1 : 0) +
        (r.certificateDaysLeft !== null && r.certificateDaysLeft <= 30 ? 1 : 0) +
        r.ownerCertificates.filter((c) => c.daysLeft <= 30).length;
      return {
        ...r,
        tenantName: t.name,
        tenantSlug: t.slug,
        invoicingMode: t.invoicingMode,
        issues,
      };
    });
    list.sort((a, b) => b.issues - a.issues || a.tenantName.localeCompare(b.tenantName));

    const invoices: AdminBillingIssueInvoiceDto[] = problemInvoices.map((i) => {
      const unsentRow = i.aeatStatus === 'pending' && i.aeatSentAt === null;
      return {
        invoiceId: i.id,
        tenantId: i.tenantId,
        tenantName: i.tenant.name,
        invoiceNumber: i.invoiceNumber,
        issueDate: i.issueDate?.toISOString().slice(0, 10) ?? null,
        aeatStatus: i.aeatStatus ?? 'pending',
        aeatSentAt: i.aeatSentAt?.toISOString() ?? null,
        unsent: unsentRow,
        // Sin enviar: lo que importa es el último error del emisor, no una respuesta antigua.
        message: unsentRow
          ? (emitterOf(i.tenantId, i.ownerId ?? null)?.lastError?.slice(0, 300) ??
            aeatMessage(i.aeatResponse))
          : aeatMessage(i.aeatResponse),
      };
    });
    return { aeatMode: this.aeatMode(), tenants: list, invoices, invoicesTotal };
  }

  private async withNames(
    rows: { tenantId: string; count: number }[],
  ): Promise<AdminTenantIssueCountDto[]> {
    if (rows.length === 0) return [];
    const tenants = await this.admin.tenant.findMany({
      where: {
        id: { in: rows.map((r) => r.tenantId) },
        deletedAt: null,
        status: { not: 'cancelled' },
      },
      select: { id: true, name: true },
    });
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return rows
      .filter((r) => names.has(r.tenantId))
      .map((r) => ({ tenantId: r.tenantId, tenantName: names.get(r.tenantId)!, count: r.count }))
      .sort((a, b) => b.count - a.count);
  }
}
