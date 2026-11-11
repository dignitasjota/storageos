import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DUNNING_TEMPLATE_CODES,
  type DunningSettingsDto,
  type DunningSettingsInput,
} from '@storageos/shared';

import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';

/**
 * El escalado de impagos en una pantalla: los días de los dos recordatorios,
 * el recargo, el corte del acceso y el aviso legal. Los cambios valen para las
 * facturas que venzan a partir de ahora; las ya vencidas siguen su calendario.
 */
@Injectable()
export class DunningSettingsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string): Promise<DunningSettingsDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        dunningFirstReminderDays: true,
        dunningSecondReminderDays: true,
        lateFeeEnabled: true,
        lateFeeType: true,
        lateFeeValue: true,
        lateFeeGraceDays: true,
        accessCutMode: true,
        accessCutDays: true,
        collectionsOpenAfterDays: true,
        collectionsEnabled: true,
      },
    });
    if (!t) throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    const templates = await this.admin.messageTemplate.findMany({
      where: {
        tenantId,
        code: { in: Object.values(DUNNING_TEMPLATE_CODES) },
      },
      select: { id: true, code: true },
    });
    const idOf = (code: string) => templates.find((x) => x.code === code)?.id ?? null;
    return {
      firstReminderDays: t.dunningFirstReminderDays,
      secondReminderDays: t.dunningSecondReminderDays,
      lateFeeEnabled: t.lateFeeEnabled,
      lateFeeType: t.lateFeeType === 'fixed' ? 'fixed' : 'percentage',
      lateFeeValue: Number(t.lateFeeValue),
      lateFeeGraceDays: t.lateFeeGraceDays,
      accessCutMode:
        t.accessCutMode === 'extras' || t.accessCutMode === 'none' ? t.accessCutMode : 'all',
      accessCutDays: t.accessCutDays,
      legalNoticeDays: t.collectionsOpenAfterDays,
      collectionsEnabled:
        t.collectionsEnabled && (await tenantHasFeature(this.admin, tenantId, 'collections')),
      templates: {
        firstReminder: idOf(DUNNING_TEMPLATE_CODES.firstReminder),
        secondReminder: idOf(DUNNING_TEMPLATE_CODES.secondReminder),
      },
    };
  }

  async update(
    tenantId: string,
    userId: string,
    input: DunningSettingsInput,
    meta: RequestMeta,
  ): Promise<DunningSettingsDto> {
    const data = {
      dunningFirstReminderDays: input.firstReminderDays,
      dunningSecondReminderDays: input.secondReminderDays,
      lateFeeEnabled: input.lateFeeEnabled,
      lateFeeType: input.lateFeeType,
      lateFeeValue: input.lateFeeValue,
      lateFeeGraceDays: input.lateFeeGraceDays,
      accessCutMode: input.accessCutMode,
      accessCutDays: input.accessCutDays,
      collectionsOpenAfterDays: input.legalNoticeDays,
    } satisfies Prisma.TenantUpdateInput;
    await this.admin.tenant.update({ where: { id: tenantId }, data });
    await this.audit.write({
      tenantId,
      userId,
      action: 'tenant.dunning.settings_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: data as unknown as Prisma.InputJsonValue,
      ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    });
    return this.get(tenantId);
  }
}
