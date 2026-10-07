import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { AdminTenantUsageRowDto, AdminUsageDto } from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Uso de cada tenant para el super admin: correos que envía a sus inquilinos
 * (con rebotes y quejas de spam, porque la cuenta de envío es compartida),
 * consumo del asistente de IA (tokens y coste estimado) y almacenamiento.
 */
@Injectable()
export class AdminUsageService {
  private readonly inputPrice: number;
  private readonly outputPrice: number;

  constructor(
    private readonly admin: PrismaAdminService,
    config: ConfigService<Env, true>,
  ) {
    this.inputPrice = config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true });
    this.outputPrice = config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true });
  }

  async getUsage(days = 30, now = new Date()): Promise<AdminUsageDto> {
    const period = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const since = new Date(now.getTime() - period * DAY_MS);

    const [tenants, emailRows, complaintRows, aiRows, storageRows] = await Promise.all([
      this.admin.tenant.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.communication.groupBy({
        by: ['tenantId', 'status'],
        where: { channel: 'email', createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.admin.emailSuppression.groupBy({
        by: ['tenantId'],
        where: { tenantId: { not: null }, scope: 'marketing', createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.admin.aiUsageEvent.groupBy({
        by: ['tenantId'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.admin.tenantStorageUsage.findMany(),
    ]);

    const email = new Map<string, { sent: number; bounced: number; failed: number }>();
    for (const r of emailRows) {
      const e = email.get(r.tenantId) ?? { sent: 0, bounced: 0, failed: 0 };
      if (r.status === 'sent' || r.status === 'delivered') e.sent += r._count._all;
      if (r.status === 'bounced') e.bounced += r._count._all;
      if (r.status === 'failed') e.failed += r._count._all;
      email.set(r.tenantId, e);
    }
    const complaints = new Map(complaintRows.map((r) => [r.tenantId ?? '', r._count._all]));
    const ai = new Map(aiRows.map((r) => [r.tenantId, r]));
    const storage = new Map(storageRows.map((r) => [r.tenantId, r]));

    const rows: AdminTenantUsageRowDto[] = tenants.map((t) => {
      const e = email.get(t.id) ?? { sent: 0, bounced: 0, failed: 0 };
      const a = ai.get(t.id);
      const inputTokens = a?._sum.inputTokens ?? 0;
      const outputTokens = a?._sum.outputTokens ?? 0;
      const s = storage.get(t.id);
      const attempted = e.sent + e.bounced;
      return {
        tenantId: t.id,
        tenantName: t.name,
        tenantSlug: t.slug,
        email: {
          ...e,
          complaints: complaints.get(t.id) ?? 0,
          bounceRate: attempted > 0 ? Math.round((e.bounced / attempted) * 1000) / 10 : null,
        },
        ai: {
          calls: a?._count._all ?? 0,
          inputTokens,
          outputTokens,
          costUsd: this.cost(inputTokens, outputTokens),
        },
        storage: {
          bytes: s ? Number(s.bytes) : 0,
          objects: s?.objects ?? 0,
          measuredAt: s?.measuredAt.toISOString() ?? null,
        },
      };
    });

    const storageMeasuredAt = storageRows.reduce<Date | null>(
      (max, r) => (!max || r.measuredAt > max ? r.measuredAt : max),
      null,
    );

    return {
      days: period,
      rows,
      totals: {
        emailsSent: rows.reduce((n, r) => n + r.email.sent, 0),
        aiCostUsd: Math.round(rows.reduce((n, r) => n + r.ai.costUsd, 0) * 100) / 100,
        storageBytes: rows.reduce((n, r) => n + r.storage.bytes, 0),
      },
      aiPricing: { inputPerMTokUsd: this.inputPrice, outputPerMTokUsd: this.outputPrice },
      storageMeasuredAt: storageMeasuredAt?.toISOString() ?? null,
    };
  }

  private cost(input: number, output: number): number {
    const usd = (input * this.inputPrice + output * this.outputPrice) / 1_000_000;
    return Math.round(usd * 100) / 100;
  }
}
