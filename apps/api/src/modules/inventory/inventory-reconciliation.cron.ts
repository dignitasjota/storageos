import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

import { InventoryService } from './inventory.service';

/**
 * Revisa a diario el inventario de cada tenant y, si detecta trasteros en un
 * estado imposible, avisa al staff (notificación in-app) para que lo corrija.
 * Solo se registra cuando `ENABLE_WORKERS_IN_API=true` (corre en el worker).
 */
@Injectable()
export class InventoryReconciliationCron {
  private readonly logger = new Logger(InventoryReconciliationCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 5 * * *', { name: 'inventory.reconciliation' })
  async run(): Promise<{ tenantsWithIssues: number }> {
    // Tenants con al menos un trastero (candidatos a tener descuadres).
    const tenants = await this.admin.unit.findMany({
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    let tenantsWithIssues = 0;
    for (const t of tenants) {
      const issues = await this.inventory.findIssues(t.tenantId);
      if (issues.length === 0) continue;
      tenantsWithIssues++;
      await this.notifications
        .create(t.tenantId, {
          type: 'inventory.issues',
          title: `${issues.length} trastero(s) con estado inconsistente`,
          body: 'Revisa el inventario: hay trasteros cuyo estado no cuadra con sus contratos.',
          link: '/units',
        })
        .catch(() => {
          /* best-effort */
        });
    }
    if (tenantsWithIssues > 0) {
      this.logger.log(`[inventory] ${tenantsWithIssues} tenant(s) con descuadres`);
    }
    return { tenantsWithIssues };
  }
}
