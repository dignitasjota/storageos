import { Injectable, Logger } from '@nestjs/common';
import {
  PLATFORM_EMAIL_KIND_INFO,
  type PlatformEmailKind,
  type PlatformEmailLogDto,
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
    if (e.outcome === 'delivered') {
      await this.admin.platformEmailLog.updateMany({
        where: { id: row.id, status: 'sent' },
        data: { status: 'delivered', deliveredAt: e.occurredAt },
      });
    } else if (e.outcome === 'bounced' || e.outcome === 'failed') {
      await this.admin.platformEmailLog.updateMany({
        where: { id: row.id, status: { in: ['sent', 'delivered'] } },
        data: { status: e.outcome, errorMessage: e.reason },
      });
    }
    return true;
  }

  async list(f: PlatformEmailLogFilters): Promise<PlatformEmailLogPageDto> {
    const take = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const where: Prisma.PlatformEmailLogWhereInput = {};
    if (f.tenantId) where.tenantId = f.tenantId;
    if (f.kind) where.kind = f.kind;
    if (f.status) where.status = f.status;
    const q = f.search?.trim();
    if (q) {
      const contains = { contains: q, mode: 'insensitive' as const };
      where.OR = [{ recipient: contains }, { subject: contains }, { tenant: { name: contains } }];
    }
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
}
