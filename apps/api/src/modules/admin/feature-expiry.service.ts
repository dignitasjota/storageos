import { Injectable, Logger } from '@nestjs/common';
import { FEATURE_LABELS, type TenantFeature } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';

import type { AdminExpiringOverrideDto } from '@storageos/shared';

const DAY = 86_400_000;
/** Días antes del fin de una prueba gratis en que se avisa al tenant. */
const TRIAL_NOTICE_DAYS = 3;

/**
 * Cortesías y pruebas gratis con fecha de fin: avisa al tenant cuando a su
 * prueba le quedan pocos días, quita las caducadas (con aviso al tenant si era
 * una prueba y al super admin siempre) y lista las que vencen pronto para «Hoy».
 */
@Injectable()
export class FeatureExpiryService {
  private readonly logger = new Logger(FeatureExpiryService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly lifecycle: TenantLifecycleEmailsService,
  ) {}

  private label(feature: string): string {
    return FEATURE_LABELS[feature as TenantFeature] ?? feature;
  }

  async run(now = new Date()): Promise<{ notified: number; expired: number }> {
    let notified = 0;
    let expired = 0;

    const soon = await this.admin.tenantFeatureOverride.findMany({
      where: {
        source: 'trial',
        expiryNotifiedAt: null,
        expiresAt: { gt: now, lte: new Date(now.getTime() + TRIAL_NOTICE_DAYS * DAY) },
      },
      include: { tenant: { select: { name: true } }, trialAddon: { select: { name: true } } },
    });
    for (const o of soon) {
      const claimed = await this.admin.tenantFeatureOverride.updateMany({
        where: { id: o.id, expiryNotifiedAt: null },
        data: { expiryNotifiedAt: now },
      });
      if (claimed.count === 0) continue;
      await this.lifecycle.sendFeatureTrialNotice(o.tenantId, `feature_trial_ending:${o.id}`, {
        tenantName: o.tenant.name,
        addonName: o.trialAddon?.name ?? this.label(o.feature),
        expiresAt: o.expiresAt!,
        ended: false,
      });
      notified += 1;
    }

    const due = await this.admin.tenantFeatureOverride.findMany({
      where: { expiresAt: { lte: now } },
      include: { tenant: { select: { name: true } }, trialAddon: { select: { name: true } } },
    });
    for (const o of due) {
      const removed = await this.admin.tenantFeatureOverride.deleteMany({
        where: { id: o.id, expiresAt: { lte: now } },
      });
      if (removed.count === 0) continue;
      expired += 1;
      const name = o.trialAddon?.name ?? this.label(o.feature);
      if (o.source === 'trial') {
        await this.lifecycle.sendFeatureTrialNotice(o.tenantId, `feature_trial_ended:${o.id}`, {
          tenantName: o.tenant.name,
          addonName: name,
          expiresAt: o.expiresAt!,
          ended: true,
        });
      }
      await this.admin.superAdminNotification.create({
        data: {
          type: o.source === 'trial' ? 'feature_trial.ended' : 'feature_courtesy.ended',
          title:
            o.source === 'trial'
              ? `Terminó la prueba de ${name} de ${o.tenant.name}`
              : `Caducó la cortesía de ${name} de ${o.tenant.name}`,
          body:
            o.source === 'trial'
              ? 'No la ha contratado: se ha desactivado y se le ha avisado. Buen momento para llamarle.'
              : 'Se ha desactivado.',
          link: `/admin/tenants/${o.tenantId}`,
        },
      });
    }
    if (notified + expired > 0) {
      this.logger.log(`feature-expiry: ${notified} avisos, ${expired} caducadas`);
    }
    return { notified, expired };
  }

  /** Cortesías y pruebas que vencen en los próximos `days` días. */
  async expiringSoon(now = new Date(), days = 7): Promise<AdminExpiringOverrideDto[]> {
    const rows = await this.admin.tenantFeatureOverride.findMany({
      where: {
        source: { in: ['manual', 'trial'] },
        expiresAt: { gt: now, lte: new Date(now.getTime() + days * DAY) },
        tenant: { deletedAt: null },
      },
      include: { tenant: { select: { name: true } }, trialAddon: { select: { name: true } } },
      orderBy: { expiresAt: 'asc' },
    });
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      feature: r.feature as TenantFeature,
      source: r.source === 'trial' ? 'trial' : 'manual',
      expiresAt: r.expiresAt!.toISOString(),
      daysLeft: Math.max(0, Math.ceil((r.expiresAt!.getTime() - now.getTime()) / DAY)),
      trialAddonName: r.trialAddon?.name ?? null,
    }));
  }
}
