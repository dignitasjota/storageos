import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PLATFORM_EMAIL_KIND_INFO,
  type PlatformEmailKind,
  type PlatformEmailBodyDto,
  type PlatformEmailLogDto,
  type PlatformEmailProblemDto,
  type PlatformEmailStatsDto,
  type PlatformEmailStatsKindDto,
  type PlatformEmailStatsWeekDto,
  type PlatformEmailLogPageDto,
  type PlatformEmailLogStatus,
  type PlatformSenderCategory,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';

export interface PlatformEmailRecord {
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
  announcementId?: string | undefined;
  kind?: PlatformEmailKind | undefined;
  category?: PlatformSenderCategory | undefined;
  status: 'sent' | 'failed' | 'suppressed';
  provider?: string | null | undefined;
  providerMessageId?: string | null | undefined;
  error?: string | null | undefined;
}

export interface PlatformEmailLogFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  tenantId?: string;
  kind?: string;
  status?: string;
  announcementId?: string;
}

/**
 * Historial de los correos que manda la plataforma (los que salen sin
 * `tenantId`). Los de un tenant a sus inquilinos quedan en `communications`.
 * Registrar nunca rompe un envío.
 */
@Injectable()
export class PlatformEmailLogService {
  private readonly logger = new Logger(PlatformEmailLogService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  async record(r: PlatformEmailRecord): Promise<void> {
    try {
      const category = r.kind ? PLATFORM_EMAIL_KIND_INFO[r.kind].category : (r.category ?? null);
      await this.admin.platformEmailLog.create({
        data: {
          tenantId: await this.tenantFor(r.to),
          recipient: r.to.toLowerCase(),
          subject: r.subject.slice(0, 500),
          // Los correos de cuenta llevan enlaces que dan acceso: no se guardan.
          bodyText: category === 'account' ? null : r.text.slice(0, 20_000),
          bodyHtml: category === 'account' || !r.html ? null : r.html.slice(0, 200_000),
          announcementId: r.announcementId ?? null,
          kind: r.kind ?? null,
          category,
          status: r.status,
          provider: r.provider ?? null,
          providerMessageId: r.providerMessageId ?? null,
          errorMessage: r.error ? r.error.slice(0, 1000) : null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[platform-email-log] no se pudo registrar el correo a ${r.to}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Aviso de entrega de Brevo/Resend para un correo de la plataforma.
   * Devuelve true si era uno de los suyos.
   */
  async applyDelivery(
    messageIds: string[],
    e: { outcome: string; reason: string | null; occurredAt: Date },
  ): Promise<boolean> {
    const row = await this.admin.platformEmailLog.findFirst({
      where: { providerMessageId: { in: messageIds } },
      select: { id: true },
    });
    if (!row) return false;
    // Un rebote temporal queda como rebotado con su motivo; si el reintento
    // llega, pasa a entregado, y si rebota del todo, cambia el motivo.
    const softBounced = { status: 'bounced', errorMessage: { startsWith: 'Rebote temporal' } };
    if (e.outcome === 'delivered') {
      await this.admin.platformEmailLog.updateMany({
        where: { id: row.id, OR: [{ status: 'sent' }, softBounced] },
        data: { status: 'delivered', deliveredAt: e.occurredAt, errorMessage: null },
      });
    } else if (e.outcome === 'soft_bounced') {
      await this.admin.platformEmailLog.updateMany({
        where: { id: row.id, status: 'sent' },
        data: { status: 'bounced', errorMessage: e.reason },
      });
    } else if (e.outcome === 'bounced' || e.outcome === 'failed') {
      await this.admin.platformEmailLog.updateMany({
        where: { id: row.id, OR: [{ status: { in: ['sent', 'delivered'] } }, softBounced] },
        data: { status: e.outcome, errorMessage: e.reason },
      });
    }
    return true;
  }

  async list(f: PlatformEmailLogFilters): Promise<PlatformEmailLogPageDto> {
    const take = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const where = this.whereFor(f);
    const rows = await this.admin.platformEmailLog.findMany({
      where,
      include: { tenant: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    return {
      items: page.map(
        (r): PlatformEmailLogDto => ({
          id: r.id,
          tenantId: r.tenantId,
          tenantName: r.tenant?.name ?? null,
          recipient: r.recipient,
          subject: r.subject,
          bodyText: r.bodyText,
          kind: r.kind,
          category: r.category,
          status: r.status as PlatformEmailLogStatus,
          provider: r.provider,
          errorMessage: r.errorMessage,
          deliveredAt: r.deliveredAt?.toISOString() ?? null,
          hasHtml: r.bodyHtml != null,
          announcementId: r.announcementId,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Tenant del destinatario, para filtrar el historial por tenant: un usuario
   * con ese email (si es de un solo tenant) o el email de facturación.
   */
  private async tenantFor(email: string): Promise<string | null> {
    const users = await this.admin.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { tenantId: true },
      take: 5,
    });
    const ids = [...new Set(users.map((u) => u.tenantId))];
    if (ids.length === 1) return ids[0] ?? null;
    if (ids.length > 1) return null;
    const tenants = await this.admin.tenant.findMany({
      where: { billingEmail: { equals: email, mode: 'insensitive' } },
      select: { id: true },
      take: 2,
    });
    return tenants.length === 1 ? (tenants[0]?.id ?? null) : null;
  }

  private whereFor(f: PlatformEmailLogFilters): Prisma.PlatformEmailLogWhereInput {
    const where: Prisma.PlatformEmailLogWhereInput = {};
    if (f.tenantId) where.tenantId = f.tenantId;
    if (f.kind) where.kind = f.kind;
    if (f.status) where.status = f.status;
    if (f.announcementId) where.announcementId = f.announcementId;
    const q = f.search?.trim();
    if (q) {
      const contains = { contains: q, mode: 'insensitive' as const };
      where.OR = [{ recipient: contains }, { subject: contains }, { tenant: { name: contains } }];
    }
    return where;
  }

  /** HTML y texto de un correo (null en los de cuenta). */
  async body(id: string): Promise<PlatformEmailBodyDto> {
    const row = await this.admin.platformEmailLog.findUnique({
      where: { id },
      select: { bodyHtml: true, bodyText: true },
    });
    if (!row) {
      throw new NotFoundException({ code: 'email_not_found', message: 'Correo no encontrado' });
    }
    return { html: row.bodyHtml, text: row.bodyText };
  }

  /** Lo que hace falta para reenviar un correo (solo los que se guardaron enteros). */
  async forResend(id: string): Promise<{
    recipient: string;
    subject: string;
    html: string;
    text: string;
    kind: PlatformEmailKind | null;
    announcementId: string | null;
  }> {
    const row = await this.admin.platformEmailLog.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'email_not_found', message: 'Correo no encontrado' });
    }
    if (!row.bodyHtml || !row.bodyText) {
      throw new BadRequestException({
        code: 'email_not_resendable',
        message: 'Este correo no se puede reenviar (los de acceso a la cuenta no se guardan).',
      });
    }
    return {
      recipient: row.recipient,
      subject: row.subject,
      html: row.bodyHtml,
      text: row.bodyText,
      kind: (row.kind as PlatformEmailKind | null) ?? null,
      announcementId: row.announcementId,
    };
  }

  /** Por semana (las últimas N) y por tipo de correo. */
  async stats(weeks: number): Promise<PlatformEmailStatsDto> {
    const n = Math.min(Math.max(weeks, 1), 26);
    const start = mondayOf(new Date(Date.now() - (n - 1) * 7 * 86_400_000));
    const rows = await this.admin.platformEmailLog.findMany({
      where: { createdAt: { gte: start } },
      select: { createdAt: true, status: true, kind: true },
    });
    const weekMap = new Map<string, PlatformEmailStatsWeekDto>();
    for (let i = 0; i < n; i += 1) {
      const d = new Date(start.getTime() + i * 7 * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      weekMap.set(key, { week: key, sent: 0, delivered: 0, bounced: 0, failed: 0 });
    }
    const kindMap = new Map<string, PlatformEmailStatsKindDto>();
    for (const r of rows) {
      const w = weekMap.get(mondayOf(r.createdAt).toISOString().slice(0, 10));
      if (w) {
        w.sent += 1;
        if (r.status === 'delivered') w.delivered += 1;
        if (r.status === 'bounced') w.bounced += 1;
        if (r.status === 'failed' || r.status === 'suppressed') w.failed += 1;
      }
      const k = r.kind ?? '';
      const kd = kindMap.get(k) ?? {
        kind: r.kind,
        total: 0,
        delivered: 0,
        bounced: 0,
        failed: 0,
        suppressed: 0,
      };
      kd.total += 1;
      if (r.status === 'delivered') kd.delivered += 1;
      if (r.status === 'bounced') kd.bounced += 1;
      if (r.status === 'failed') kd.failed += 1;
      if (r.status === 'suppressed') kd.suppressed += 1;
      kindMap.set(k, kd);
    }
    return {
      weeks: [...weekMap.values()],
      byKind: [...kindMap.values()].sort((a, b) => b.total - a.total),
    };
  }

  /** Direcciones con dos o más rebotes o fallos en 90 días. */
  async problems(): Promise<PlatformEmailProblemDto[]> {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const groups = await this.admin.platformEmailLog.groupBy({
      by: ['recipient', 'status'],
      where: { createdAt: { gte: since }, status: { in: ['bounced', 'failed', 'suppressed'] } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const byRecipient = new Map<string, { bounced: number; failed: number; lastAt: Date }>();
    for (const g of groups) {
      const cur = byRecipient.get(g.recipient) ?? { bounced: 0, failed: 0, lastAt: new Date(0) };
      if (g.status === 'bounced') cur.bounced += g._count._all;
      else cur.failed += g._count._all;
      if (g._max.createdAt && g._max.createdAt > cur.lastAt) cur.lastAt = g._max.createdAt;
      byRecipient.set(g.recipient, cur);
    }
    const repeated = [...byRecipient.entries()].filter(([, v]) => v.bounced + v.failed >= 2);
    if (repeated.length === 0) return [];
    const emails = repeated.map(([e]) => e);
    const [lasts, users] = await Promise.all([
      this.admin.platformEmailLog.findMany({
        where: {
          recipient: { in: emails },
          status: { in: ['bounced', 'failed', 'suppressed'] },
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['recipient'],
        select: {
          recipient: true,
          errorMessage: true,
          tenantId: true,
          tenant: { select: { name: true } },
        },
      }),
      this.admin.user.findMany({
        where: { email: { in: emails, mode: 'insensitive' }, role: 'owner' },
        select: { email: true, tenantId: true, tenant: { select: { name: true } } },
      }),
    ]);
    const lastBy = new Map(lasts.map((l) => [l.recipient, l]));
    const ownerBy = new Map(users.map((u) => [u.email.toLowerCase(), u]));
    return repeated
      .map(([recipient, v]): PlatformEmailProblemDto => {
        const last = lastBy.get(recipient);
        const owner = ownerBy.get(recipient);
        return {
          recipient,
          tenantId: owner?.tenantId ?? last?.tenantId ?? null,
          tenantName: owner?.tenant.name ?? last?.tenant?.name ?? null,
          isOwner: !!owner,
          bounced: v.bounced,
          failed: v.failed,
          lastError: last?.errorMessage ?? null,
          lastAt: v.lastAt.toISOString(),
        };
      })
      .sort((a, b) => b.bounced + b.failed - (a.bounced + a.failed));
  }

  /** CSV (`;`, coma decimal no aplica) de lo filtrado, hasta 5.000 filas. */
  async exportCsv(f: PlatformEmailLogFilters): Promise<string> {
    const rows = await this.admin.platformEmailLog.findMany({
      where: this.whereFor(f),
      include: { tenant: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const cell = (v: string | null | undefined) => {
      const s = (v ?? '').replace(/\r?\n/g, ' ');
      return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['Fecha', 'Destinatario', 'Tenant', 'Asunto', 'Tipo', 'Estado', 'Error'];
    const lines = rows.map((r) =>
      [
        r.createdAt.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
        r.recipient,
        r.tenant?.name ?? '',
        r.subject,
        r.kind ? (PLATFORM_EMAIL_KIND_INFO[r.kind as PlatformEmailKind]?.label ?? r.kind) : '',
        r.status,
        r.errorMessage ?? '',
      ]
        .map(cell)
        .join(';'),
    );
    return `${String.fromCharCode(0xfeff)}${[head.join(';'), ...lines].join('\n')}\n`;
  }
}

/** Lunes (00:00 UTC) de la semana de una fecha. */
function mondayOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}
