import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  aeatErrorGuide,
  BILLING_INVOICE_PROBLEMS,
  BILLING_STALE_HOURS,
  extractAeatErrorCode,
  type BillingBatchResultDto,
  type BillingCertificateRowDto,
  type BillingInvoiceProblem,
  type BillingIssueDetailDto,
  type BillingIssueRowDto,
  type BillingIssuesPageDto,
  type BillingOtherProblemDto,
  type BillingOtherProblemsDto,
  type BillingStuckSubmissionDto,
  type BillingTenantProblem,
  type BillingVerifactuTenantDto,
} from '@storageos/shared';

import { HoldedSyncService } from '../accounting/holded-sync.service';
import { InvoicesService } from '../billing/invoices.service';
import { VerifactuDispatcher } from '../billing/verifactu-dispatcher.service';
import { emitterKey } from '../billing/verifactu-flow';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface BillingActionMeta {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Tenants vivos con Veri*Factu activado: los únicos que tienen problemas de envío. */
const LIVE_VERIFACTU_TENANT: Prisma.TenantWhereInput = {
  deletedAt: null,
  status: { not: 'cancelled' },
  verifactuEnabled: true,
};

function messageOf(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  for (const key of ['message', 'descripcionErrorRegistro', 'error', 'errorMessage']) {
    if (typeof r[key] === 'string' && r[key]) return r[key] as string;
  }
  return null;
}

function rawOf(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  return (response as Record<string, unknown>).raw;
}

/**
 * Problemas de facturación de los tenants (panel super admin): envíos
 * atascados, vista de Veri*Factu por tenant, facturas con problema paginadas,
 * ficha de cada incidencia, acciones en lote, calendario de certificados y otros
 * problemas de emisión. Convive con `AdminOpsHealthService.billingHealth()`
 * (resumen de siempre), sin reescribirlo.
 */
@Injectable()
export class AdminBillingOpsHealthService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly holded: HoldedSyncService,
    private readonly invoices: InvoicesService,
    private readonly dispatcher: VerifactuDispatcher,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly audit: SuperAdminAuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private staleCut(now: Date): Date {
    return new Date(now.getTime() - BILLING_STALE_HOURS * HOUR_MS);
  }

  /** Factura con este tipo de problema. */
  private problemWhere(type: BillingInvoiceProblem, now: Date): Prisma.InvoiceWhereInput {
    const cut = this.staleCut(now);
    switch (type) {
      case 'rejected':
        return { aeatStatus: 'rejected' };
      case 'error':
        return { aeatStatus: 'error' };
      case 'warnings':
        return { aeatStatus: 'accepted_with_warnings' };
      case 'stale':
        return { aeatStatus: 'pending', aeatSentAt: { lt: cut } };
      case 'unsent':
        return {
          aeatStatus: 'pending',
          aeatSentAt: null,
          verifactuRecords: {
            some: { status: { in: ['pending', 'error'] }, sentAt: null, createdAt: { lt: cut } },
          },
        };
    }
  }

  private problemOf(aeatStatus: string | null, sentAt: Date | null): BillingInvoiceProblem {
    if (aeatStatus === 'rejected') return 'rejected';
    if (aeatStatus === 'error') return 'error';
    if (aeatStatus === 'accepted_with_warnings') return 'warnings';
    return sentAt ? 'stale' : 'unsent';
  }

  private mode(): 'sandbox' | 'production' | 'stub' {
    return this.config.get('AEAT_MODE', { infer: true });
  }

  // ------------------------------------------------------ 1. envíos atascados

  /** Emisores con registros sin enviar: desde cuándo, intentos y último error. */
  async stuckSubmissions(
    opts: { all?: boolean } = {},
    now = new Date(),
  ): Promise<BillingStuckSubmissionDto[]> {
    const groups = await this.admin.verifactuRecord.groupBy({
      by: ['tenantId', 'ownerId'],
      where: { status: { in: ['pending', 'error'] }, tenant: LIVE_VERIFACTU_TENANT },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    if (groups.length === 0) return [];
    const tenantIds = [...new Set(groups.map((g) => g.tenantId))];
    const [emitters, tenants, owners] = await Promise.all([
      this.admin.verifactuEmitter.findMany({ where: { tenantId: { in: tenantIds } } }),
      this.admin.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
      }),
      this.admin.owner.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { id: true, legalName: true },
      }),
    ]);
    const emitterBy = new Map(emitters.map((e) => [`${e.tenantId}:${e.emitterKey}`, e]));
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    const ownerName = new Map(owners.map((o) => [o.id, o.legalName]));
    const minAge = now.getTime() - 30 * 60 * 1000;
    return groups
      .map((g): BillingStuckSubmissionDto => {
        const e = emitterBy.get(`${g.tenantId}:${emitterKey(g.ownerId)}`);
        return {
          tenantId: g.tenantId,
          tenantName: tenantName.get(g.tenantId) ?? '—',
          ownerId: g.ownerId,
          emitterName: g.ownerId ? (ownerName.get(g.ownerId) ?? null) : null,
          pendingRecords: g._count._all,
          oldestPendingAt: g._min.createdAt?.toISOString() ?? null,
          consecutiveFailures: e?.consecutiveFailures ?? 0,
          lastError: e?.lastError ?? null,
          retryAt: e?.retryAt?.toISOString() ?? null,
          nextSendAt: e?.nextSendAt?.toISOString() ?? null,
        };
      })
      .filter(
        (s) =>
          opts.all ||
          s.consecutiveFailures > 0 ||
          (s.oldestPendingAt !== null && new Date(s.oldestPendingAt).getTime() < minAge),
      )
      .sort((a, b) => (a.oldestPendingAt ?? '').localeCompare(b.oldestPendingAt ?? ''));
  }

  /** «Reintentar ahora»: envía ya lo pendiente de un emisor (sin esperar al reintento). */
  async retryStuck(
    tenantId: string,
    ownerId: string | null,
    meta: BillingActionMeta,
  ): Promise<{ scheduledAt: string }> {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const pending = await this.admin.verifactuRecord.count({
      where: { tenantId, ownerId, status: { in: ['pending', 'error'] } },
    });
    if (pending === 0) {
      throw new BadRequestException({
        code: 'nothing_pending',
        message: 'No hay registros pendientes de enviar de este emisor',
      });
    }
    const at = await this.dispatcher.schedule(tenantId, ownerId, { retryNow: true });
    await this.trace(meta, 'admin.billing.stuck_retried', tenantId, { ownerId, pending });
    return { scheduledAt: at.toISOString() };
  }

  // ------------------------------------------- 2. vista de Veri*Factu por tenant

  async verifactuTenants(
    opts: { problem?: BillingTenantProblem | undefined; search?: string | undefined } = {},
    now = new Date(),
  ): Promise<BillingVerifactuTenantDto[]> {
    const search = opts.search?.trim();
    const tenants = await this.admin.tenant.findMany({
      where: {
        ...LIVE_VERIFACTU_TENANT,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { slug: { contains: search.toLowerCase() } },
              ],
            }
          : {}),
      },
      select: { id: true, name: true, slug: true, invoicingMode: true },
      orderBy: { name: 'asc' },
    });
    if (tenants.length === 0) return [];
    const ids = tenants.map((t) => t.id);
    const invoiceBase = { tenantId: { in: ids }, deletedAt: null } as const;
    const [byStatus, stale, unsent, pendingRecords, accepted, creds, holdedOn] = await Promise.all([
      this.admin.invoice.groupBy({
        by: ['tenantId', 'aeatStatus'],
        where: {
          ...invoiceBase,
          aeatStatus: { in: ['rejected', 'error', 'accepted_with_warnings'] },
        },
        _count: { _all: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: { ...invoiceBase, ...this.problemWhere('stale', now) },
        _count: { _all: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: { ...invoiceBase, ...this.problemWhere('unsent', now) },
        _count: { _all: true },
      }),
      this.admin.verifactuRecord.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, status: { in: ['pending', 'error'] } },
        _count: { _all: true },
      }),
      this.admin.verifactuSubmission.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, status: 'accepted' },
        _max: { sentAt: true },
      }),
      this.admin.tenantAeatCredential.findMany({
        where: { tenantId: { in: ids }, revokedAt: null },
        select: { tenantId: true, certValidTo: true },
      }),
      this.admin.holdedSettings.findMany({
        where: { tenantId: { in: ids }, enabled: true },
        select: { tenantId: true },
      }),
    ]);
    const statusCount = (tenantId: string, status: string) =>
      byStatus.find((g) => g.tenantId === tenantId && g.aeatStatus === status)?._count._all ?? 0;
    const holdedReview = new Map<string, number>();
    await Promise.all(
      holdedOn.map(async (h) =>
        holdedReview.set(h.tenantId, await this.holded.reviewCount(h.tenantId)),
      ),
    );
    const mode = this.mode();
    const certProblems = new Map<string, boolean>();
    const rows = tenants.map((t): BillingVerifactuTenantDto => {
      const certs = creds.filter((c) => c.tenantId === t.id);
      const best = certs.reduce<Date | null>(
        (acc, c) => (!acc || c.certValidTo > acc ? c.certValidTo : acc),
        null,
      );
      const daysLeft = best ? Math.ceil((best.getTime() - now.getTime()) / DAY_MS) : null;
      const row = {
        tenantId: t.id,
        tenantName: t.name,
        tenantSlug: t.slug,
        mode,
        lastAcceptedAt:
          accepted.find((a) => a.tenantId === t.id)?._max.sentAt?.toISOString() ?? null,
        pendingRecords: pendingRecords.find((p) => p.tenantId === t.id)?._count._all ?? 0,
        rejected: statusCount(t.id, 'rejected'),
        error: statusCount(t.id, 'error'),
        stale: stale.find((g) => g.tenantId === t.id)?._count._all ?? 0,
        unsent: unsent.find((g) => g.tenantId === t.id)?._count._all ?? 0,
        warnings: statusCount(t.id, 'accepted_with_warnings'),
        certificateValidTo: best?.toISOString() ?? null,
        certificateDaysLeft: daysLeft,
        hasCertificate: !!best && daysLeft! > 0,
        holdedReview: holdedReview.get(t.id) ?? 0,
        hasProblem: false,
      };
      // Quien emite en Holded no necesita certificado: no es un problema. Sin
      // certificado solo es un problema si el envío es real (no simulado).
      const certProblem =
        t.invoicingMode !== 'holded' && (daysLeft === null ? mode !== 'stub' : daysLeft <= 30);
      certProblems.set(t.id, certProblem);
      row.hasProblem =
        row.rejected + row.error + row.stale + row.unsent + row.warnings + row.holdedReview > 0 ||
        certProblem;
      return row;
    });
    const keep = (r: BillingVerifactuTenantDto): boolean => {
      switch (opts.problem) {
        case undefined:
          return true;
        case 'healthy':
          return !r.hasProblem;
        case 'certificate':
          return certProblems.get(r.tenantId) === true;
        case 'holded':
          return r.holdedReview > 0;
        default:
          return r[opts.problem] > 0;
      }
    };
    return rows.filter(keep).sort((a, b) => Number(b.hasProblem) - Number(a.hasProblem));
  }

  // --------------------------------------------- 4. lista paginada de facturas

  async issues(
    opts: {
      type?: BillingInvoiceProblem | undefined;
      tenantId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
    now = new Date(),
  ): Promise<BillingIssuesPageDto> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
    const types = opts.type ? [opts.type] : [...BILLING_INVOICE_PROBLEMS];
    const rows = await this.admin.invoice.findMany({
      where: {
        deletedAt: null,
        tenant: LIVE_VERIFACTU_TENANT,
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
        OR: types.map((t) => this.problemWhere(t, now)),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        tenantId: true,
        invoiceNumber: true,
        issueDate: true,
        aeatStatus: true,
        aeatSentAt: true,
        aeatResponse: true,
        tenant: { select: { name: true } },
        // El mensaje que cuenta es el del último registro.
        verifactuRecords: { orderBy: { chainSeq: 'desc' }, take: 1, select: { response: true } },
      },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((i): BillingIssueRowDto => {
        const response = i.verifactuRecords[0]?.response ?? i.aeatResponse;
        const message = messageOf(response) ?? messageOf(i.aeatResponse);
        return {
          invoiceId: i.id,
          tenantId: i.tenantId,
          tenantName: i.tenant.name,
          invoiceNumber: i.invoiceNumber,
          issueDate: i.issueDate?.toISOString().slice(0, 10) ?? null,
          problem: this.problemOf(i.aeatStatus, i.aeatSentAt),
          aeatStatus: i.aeatStatus ?? 'pending',
          aeatSentAt: i.aeatSentAt?.toISOString() ?? null,
          message,
          errorCode: extractAeatErrorCode(message, rawOf(response)),
        };
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  // ------------------------------------------------------ 3. ficha de incidencia

  async detail(invoiceId: string): Promise<BillingIssueDetailDto> {
    const inv = await this.admin.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        tenantId: true,
        invoiceNumber: true,
        issueDate: true,
        total: true,
        aeatStatus: true,
        aeatSentAt: true,
        aeatCsv: true,
        aeatResponse: true,
        status: true,
        tenant: { select: { name: true } },
        verifactuRecords: { orderBy: { chainSeq: 'desc' }, take: 10 },
      },
    });
    if (!inv) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const latest = inv.verifactuRecords[0] ?? null;
    // Mensaje: el del último registro, que es el que cuenta.
    const message = messageOf(latest?.response) ?? messageOf(inv.aeatResponse);
    const code = extractAeatErrorCode(message, rawOf(latest?.response) ?? rawOf(inv.aeatResponse));
    return {
      invoiceId: inv.id,
      tenantId: inv.tenantId,
      tenantName: inv.tenant.name,
      invoiceNumber: inv.invoiceNumber,
      issueDate: inv.issueDate?.toISOString().slice(0, 10) ?? null,
      total: Number(inv.total),
      aeatStatus: inv.aeatStatus ?? 'pending',
      aeatSentAt: inv.aeatSentAt?.toISOString() ?? null,
      aeatCsv: inv.aeatCsv,
      message,
      errorCode: code,
      guide: aeatErrorGuide(code, message),
      record: latest
        ? {
            id: latest.id,
            kind: latest.kind,
            subsanacion: latest.subsanacion,
            status: latest.status,
            hashShort: `${latest.hash.slice(0, 12)}…`,
            createdAt: latest.createdAt.toISOString(),
            sentAt: latest.sentAt?.toISOString() ?? null,
            hasXml: !!latest.xml,
          }
        : null,
      records: inv.verifactuRecords.map((r) => ({
        id: r.id,
        kind: r.kind,
        subsanacion: r.subsanacion,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      canResend: latest !== null && latest.status !== 'accepted',
    };
  }

  /** XML del último registro de la factura, si se guardó. */
  async recordXml(invoiceId: string): Promise<{ xml: string | null }> {
    const rec = await this.admin.verifactuRecord.findFirst({
      where: { invoiceId },
      orderBy: { chainSeq: 'desc' },
      select: { xml: true },
    });
    if (!rec) {
      throw new NotFoundException({
        code: 'record_not_found',
        message: 'Sin registro de Veri*Factu',
      });
    }
    return { xml: rec.xml };
  }

  // ------------------------------------------------------------- acciones

  async resend(
    invoiceId: string,
    reason: string,
    meta: BillingActionMeta,
  ): Promise<{ message: string }> {
    const inv = await this.admin.invoice.findUnique({
      where: { id: invoiceId },
      select: { tenantId: true, invoiceNumber: true },
    });
    if (!inv) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    await this.invoices.resendAeat(invoiceId, inv.tenantId, null, { userId: null, reason });
    await this.trace(meta, 'admin.invoice.aeat_resent', inv.tenantId, { invoiceId, reason });
    await this.interactions
      .create({
        tenantId: inv.tenantId,
        superAdminId: meta.superAdminId,
        input: {
          type: 'other',
          content: `Reenvío a la AEAT de la factura ${inv.invoiceNumber ?? invoiceId}. Motivo: ${reason}`,
        },
      })
      .catch(() => undefined);
    return { message: 'Reenvío a la AEAT en cola.' };
  }

  async refresh(invoiceId: string, meta: BillingActionMeta): Promise<{ message: string }> {
    const inv = await this.admin.invoice.findUnique({
      where: { id: invoiceId },
      select: { tenantId: true },
    });
    if (!inv) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    await this.invoices.refreshAeatStatus(invoiceId, inv.tenantId);
    await this.trace(meta, 'admin.invoice.aeat_refreshed', inv.tenantId, { invoiceId });
    return { message: 'Estado consultado en la AEAT.' };
  }

  /** Consulta o reenvía varias facturas, con el resultado de cada una (máx. 50). */
  async batch(
    action: 'refresh' | 'resend',
    invoiceIds: string[],
    reason: string | undefined,
    meta: BillingActionMeta,
  ): Promise<BillingBatchResultDto> {
    const results: BillingBatchResultDto['results'] = [];
    for (const invoiceId of [...new Set(invoiceIds)].slice(0, 50)) {
      try {
        const r =
          action === 'resend'
            ? await this.resend(invoiceId, reason ?? '', meta)
            : await this.refresh(invoiceId, meta);
        results.push({ invoiceId, ok: true, message: r.message });
      } catch (err) {
        const body =
          err && typeof err === 'object' && 'getResponse' in err
            ? ((err as { getResponse(): unknown }).getResponse() as { message?: string })
            : null;
        results.push({
          invoiceId,
          ok: false,
          message: body?.message ?? (err instanceof Error ? err.message : 'Error'),
        });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    return { results, ok, failed: results.length - ok };
  }

  // ---------------------------------------------- 7. calendario de certificados

  /** Certificados vigentes que caducan en `days` días (y los caducados hace ≤30), también de propietarios. */
  async certificates(days = 60, now = new Date()): Promise<BillingCertificateRowDto[]> {
    const rows = await this.admin.tenantAeatCredential.findMany({
      where: {
        revokedAt: null,
        certValidTo: {
          lte: new Date(now.getTime() + days * DAY_MS),
          gte: new Date(now.getTime() - 30 * DAY_MS),
        },
        tenant: { deletedAt: null, status: { not: 'cancelled' }, invoicingMode: { not: 'holded' } },
      },
      orderBy: { certValidTo: 'asc' },
      select: {
        id: true,
        tenantId: true,
        certValidTo: true,
        tenant: { select: { name: true } },
        owner: { select: { legalName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      ownerName: r.owner?.legalName ?? null,
      validTo: r.certValidTo.toISOString(),
      daysLeft: Math.ceil((r.certValidTo.getTime() - now.getTime()) / DAY_MS),
    }));
  }

  // ------------------------------------------------------- 8. otros problemas

  async otherProblems(now = new Date()): Promise<BillingOtherProblemsDto> {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const [notices, platformInvoices, tenantsApp, withoutSeries] = await Promise.all([
      this.admin.notification.findMany({
        where: {
          type: { in: ['invoice.first_invoice_failed', 'invoice.first_invoice_missing_series'] },
          createdAt: { gte: since },
          reads: { none: {} },
          tenant: { deletedAt: null, status: { not: 'cancelled' } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          tenantId: true,
          title: true,
          body: true,
          createdAt: true,
          tenant: { select: { name: true } },
        },
      }),
      this.admin.platformInvoice.findMany({
        where: {
          issuedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) },
          status: 'issued',
          OR: [{ tenantTaxId: null }, { tenantAddress: null }],
        },
        orderBy: { issuedAt: 'desc' },
        take: 100,
        select: {
          fullNumber: true,
          tenantId: true,
          tenantName: true,
          tenantTaxId: true,
          tenantAddress: true,
          issuedAt: true,
        },
      }),
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          status: { in: ['active', 'trial'] },
          invoicingMode: 'app',
          invoices: { some: { deletedAt: null } },
        },
        select: {
          id: true,
          name: true,
          taxId: true,
          billingLegalName: true,
          billingAddress: true,
          billingPostalCode: true,
          billingCity: true,
        },
      }),
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          status: { in: ['active', 'trial'] },
          invoicingMode: 'app',
          invoices: { some: { deletedAt: null } },
          invoiceSeries: { none: { isDefault: true, isActive: true, ownerId: null } },
        },
        select: { id: true, name: true },
      }),
    ]);
    const items: BillingOtherProblemDto[] = [];
    const seen = new Set<string>();
    for (const n of notices) {
      const key = `first:${n.tenantId}:${n.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        kind: 'first_invoice_failed',
        tenantId: n.tenantId,
        tenantName: n.tenant.name,
        detail: n.body ? `${n.title}. ${n.body}` : n.title,
        at: n.createdAt.toISOString(),
        link: `/admin/tenants/${n.tenantId}`,
      });
    }
    for (const p of platformInvoices) {
      const missing = [!p.tenantTaxId ? 'NIF' : null, !p.tenantAddress ? 'domicilio' : null]
        .filter(Boolean)
        .join(' y ');
      items.push({
        kind: 'platform_invoice_incomplete',
        tenantId: p.tenantId,
        tenantName: p.tenantName,
        detail: `La factura de suscripción ${p.fullNumber} no lleva ${missing} del tenant.`,
        at: p.issuedAt.toISOString(),
        link: `/admin/tenants/${p.tenantId}?tab=billing`,
      });
    }
    for (const t of withoutSeries) {
      items.push({
        kind: 'no_default_series',
        tenantId: t.id,
        tenantName: t.name,
        detail: 'Emite facturas pero no tiene una serie de facturación por defecto activa.',
        at: null,
        link: `/admin/tenants/${t.id}`,
      });
    }
    for (const t of tenantsApp) {
      const missing: string[] = [];
      if (!t.taxId) missing.push('NIF');
      if (!t.billingLegalName) missing.push('razón social');
      if (!t.billingAddress || !t.billingPostalCode || !t.billingCity)
        missing.push('domicilio fiscal');
      if (missing.length === 0) continue;
      items.push({
        kind: 'missing_fiscal_data',
        tenantId: t.id,
        tenantName: t.name,
        detail: `Factura sin datos fiscales completos: faltan ${missing.join(', ')}.`,
        at: null,
        link: `/admin/tenants/${t.id}`,
      });
    }
    return { items };
  }

  // -------------------------------------------------------------- auditoría

  private trace(meta: BillingActionMeta, action: string, tenantId: string, changes: object) {
    return this.audit.record({
      superAdminId: meta.superAdminId,
      action,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: changes as Record<string, unknown>,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }
}
