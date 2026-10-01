import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { EmailSuppressionDto } from '@storageos/shared';

export type SuppressionScope = 'all' | 'marketing';

export const SUPPRESSION_REASON_LABELS: Record<string, string> = {
  hard_bounce: 'Rebote permanente',
  invalid_email: 'Dirección de email no válida',
  blocked: 'Bloqueada por el proveedor de correo',
  complaint: 'La marcó como spam',
};

const normalize = (email: string): string => email.trim().toLowerCase();

/**
 * Lista de supresión de correo (`email_suppressions`, global). Los avisos de
 * entrega de Brevo/Resend la alimentan:
 * - rebote permanente / email inválido / bloqueado → la dirección no recibe
 *   nada, desde ningún tenant (no existe o el proveedor ya la rechaza);
 * - queja de spam → ese tenant no le envía más comunicaciones comerciales.
 */
@Injectable()
export class EmailSuppressionsService {
  private readonly logger = new Logger(EmailSuppressionsService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /** Bloqueo total de una dirección (rebote permanente…), o null. */
  async blockedForAll(email: string): Promise<{ reason: string; label: string } | null> {
    const row = await this.admin.emailSuppression.findFirst({
      where: { email: normalize(email), tenantId: null, scope: 'all' },
      select: { reason: true },
    });
    return row
      ? { reason: row.reason, label: SUPPRESSION_REASON_LABELS[row.reason] ?? row.reason }
      : null;
  }

  /** ¿No se le pueden enviar comunicaciones comerciales desde este tenant? */
  async blockedForMarketing(tenantId: string, email: string): Promise<boolean> {
    const row = await this.admin.emailSuppression.findFirst({
      where: { email: normalize(email), OR: [{ tenantId: null }, { tenantId }] },
      select: { id: true },
    });
    return !!row;
  }

  /** Registra (o actualiza) una supresión. Una por dirección y tenant. */
  async suppress(args: {
    email: string;
    tenantId: string | null;
    scope: SuppressionScope;
    reason: string;
    provider?: string | null;
    detail?: string | null;
  }): Promise<void> {
    const email = normalize(args.email);
    if (!email.includes('@')) return;
    const existing = await this.admin.emailSuppression.findFirst({
      where: { email, tenantId: args.tenantId },
      select: { id: true, scope: true },
    });
    // Un bloqueo total no se rebaja a «solo comerciales».
    const scope = existing?.scope === 'all' ? 'all' : args.scope;
    const data = {
      scope,
      reason: args.reason,
      provider: args.provider ?? null,
      detail: args.detail?.slice(0, 500) ?? null,
    };
    if (existing) {
      await this.admin.emailSuppression.update({ where: { id: existing.id }, data });
    } else {
      await this.admin.emailSuppression
        .create({ data: { email, tenantId: args.tenantId, ...data } })
        .catch((err: unknown) => {
          // Carrera con otro aviso de la misma dirección: ya está registrada.
          if ((err as { code?: string }).code !== 'P2002') throw err;
        });
    }
    this.logger.log(`[suppression] ${email} ${scope} (${args.reason}) tenant=${args.tenantId}`);
  }

  /** Supresiones que afectan a una dirección desde un tenant (globales + suyas). */
  async forTenantEmail(tenantId: string, email: string): Promise<EmailSuppressionDto[]> {
    const rows = await this.admin.emailSuppression.findMany({
      where: { email: normalize(email), OR: [{ tenantId: null }, { tenantId }] },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  /** Quita las supresiones de una dirección (globales + las del tenant). */
  async clearForTenantEmail(tenantId: string, email: string): Promise<number> {
    const res = await this.admin.emailSuppression.deleteMany({
      where: { email: normalize(email), OR: [{ tenantId: null }, { tenantId }] },
    });
    return res.count;
  }

  async list(args: { search?: string; cursor?: string; limit?: number }): Promise<{
    items: EmailSuppressionDto[];
    nextCursor: string | null;
  }> {
    const take = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const rows = await this.admin.emailSuppression.findMany({
      where: args.search ? { email: { contains: args.search.trim().toLowerCase() } } : {},
      include: { tenant: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    return {
      items: page.map((r) => this.toDto(r, r.tenant?.name ?? null)),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.admin.emailSuppression.deleteMany({ where: { id } });
    return res.count > 0;
  }

  private toDto(
    r: {
      id: string;
      email: string;
      tenantId: string | null;
      scope: string;
      reason: string;
      provider: string | null;
      detail: string | null;
      createdAt: Date;
    },
    tenantName: string | null = null,
  ): EmailSuppressionDto {
    return {
      id: r.id,
      email: r.email,
      tenantId: r.tenantId,
      tenantName,
      scope: r.scope === 'marketing' ? 'marketing' : 'all',
      reason: r.reason,
      reasonLabel: SUPPRESSION_REASON_LABELS[r.reason] ?? r.reason,
      provider: r.provider,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
