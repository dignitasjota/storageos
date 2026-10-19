import { Injectable, Logger } from '@nestjs/common';
import { FEATURE_LABELS, type TenantFeature } from '@storageos/shared';

import { tenantFeatures } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Entradas de un mismo tenant en 7 días a partir de las que se avisa al super admin. */
export const INTEREST_ALERT_THRESHOLD = 3;

/**
 * Señales de interés: cuando un usuario del tenant entra en una función que su
 * plan no incluye, se apunta (una vez por usuario, función y hora). Si un
 * tenant insiste (3 veces en 7 días), se avisa al super admin para ofrecérsela.
 */
@Injectable()
export class FeatureInterestService {
  private readonly logger = new Logger(FeatureInterestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  async record(args: {
    tenantId: string;
    userId: string;
    feature: TenantFeature;
    path?: string | undefined;
  }): Promise<{ recorded: boolean }> {
    // Si ya la tiene (p. ej. el menú iba con retraso), no es interés.
    const features = await tenantFeatures(this.admin, args.tenantId);
    if (features.includes(args.feature)) return { recorded: false };
    const now = new Date();
    const recent = await this.prisma.withTenant(
      (tx) =>
        tx.featureInterestEvent.count({
          where: {
            userId: args.userId,
            feature: args.feature,
            createdAt: { gt: new Date(now.getTime() - HOUR) },
          },
        }),
      args.tenantId,
    );
    if (recent > 0) return { recorded: false };
    await this.prisma.withTenant(
      (tx) =>
        tx.featureInterestEvent.create({
          data: {
            tenantId: args.tenantId,
            userId: args.userId,
            feature: args.feature,
            path: args.path ?? null,
          },
        }),
      args.tenantId,
    );
    await this.maybeAlert(args.tenantId, args.feature, now).catch((err: Error) =>
      this.logger.warn(`aviso de interés: ${err.message}`),
    );
    return { recorded: true };
  }

  private async maybeAlert(tenantId: string, feature: TenantFeature, now: Date): Promise<void> {
    const count = await this.admin.featureInterestEvent.count({
      where: { tenantId, feature, createdAt: { gt: new Date(now.getTime() - 7 * DAY) } },
    });
    if (count !== INTEREST_ALERT_THRESHOLD) return;
    const link = `/admin/tenants/${tenantId}?interest=${feature}`;
    const already = await this.admin.superAdminNotification.count({
      where: {
        type: 'feature_interest',
        link,
        createdAt: { gt: new Date(now.getTime() - 30 * DAY) },
      },
    });
    if (already > 0) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    await this.admin.superAdminNotification.create({
      data: {
        type: 'feature_interest',
        title: `${tenant?.name ?? 'Un tenant'} quiere ${FEATURE_LABELS[feature]}`,
        body: `Su equipo ha entrado ${count} veces esta semana en ${FEATURE_LABELS[feature]} sin tenerla. Buen momento para ofrecérsela.`,
        link,
      },
    });
  }
}
