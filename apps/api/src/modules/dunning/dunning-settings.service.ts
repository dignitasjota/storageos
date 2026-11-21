import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DUNNING_TEMPLATE_CODES,
  DUNNING_WHATSAPP_DEFAULT_TEXT,
  DUNNING_WHATSAPP_TEMPLATE_CODE,
  DUNNING_WHATSAPP_TEMPLATE_VARIABLES,
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
        dunningWhatsappReminders: true,
      },
    });
    if (!t) throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    const templates = await this.admin.messageTemplate.findMany({
      where: {
        tenantId,
        code: { in: [...Object.values(DUNNING_TEMPLATE_CODES), DUNNING_WHATSAPP_TEMPLATE_CODE] },
        deletedAt: null,
      },
      select: {
        id: true,
        code: true,
        whatsappTemplateName: true,
        whatsappTemplateLanguage: true,
      },
    });
    const whatsappTemplate = templates.find((x) => x.code === DUNNING_WHATSAPP_TEMPLATE_CODE);
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
      whatsappReminders: t.dunningWhatsappReminders,
      whatsappAvailable: await this.whatsappAvailable(tenantId),
      whatsappTemplateName: whatsappTemplate?.whatsappTemplateName ?? null,
      whatsappTemplateLanguage: whatsappTemplate?.whatsappTemplateLanguage ?? 'es',
      templates: {
        firstReminder: idOf(DUNNING_TEMPLATE_CODES.firstReminder),
        secondReminder: idOf(DUNNING_TEMPLATE_CODES.secondReminder),
        whatsapp: whatsappTemplate?.id ?? null,
      },
    };
  }

  /** ¿Tiene el negocio WhatsApp Business contratado, conectado y activo? */
  private async whatsappAvailable(tenantId: string): Promise<boolean> {
    if (!(await tenantHasFeature(this.admin, tenantId, 'whatsapp_business'))) return false;
    const row = await this.admin.tenantWhatsappSettings.findUnique({
      where: { tenantId },
      select: { enabled: true },
    });
    return !!row?.enabled;
  }

  /**
   * Guarda la plantilla de Meta del recordatorio por WhatsApp en su plantilla
   * de mensajes (la crea con el texto por defecto si no existe).
   */
  private async saveWhatsappTemplate(
    tenantId: string,
    name: string | null | undefined,
    language: string | undefined,
  ): Promise<void> {
    const existing = await this.admin.messageTemplate.findUnique({
      where: { tenantId_code: { tenantId, code: DUNNING_WHATSAPP_TEMPLATE_CODE } },
      select: { id: true, deletedAt: true },
    });
    const data = {
      ...(name !== undefined ? { whatsappTemplateName: name || null } : {}),
      ...(language !== undefined ? { whatsappTemplateLanguage: language } : {}),
    };
    if (existing) {
      await this.admin.messageTemplate.update({
        where: { id: existing.id },
        data: { ...data, ...(existing.deletedAt ? { deletedAt: null, isActive: true } : {}) },
      });
      return;
    }
    // Sin plantilla de Meta no hace falta crearla (sale el texto por defecto).
    if (!name) return;
    await this.admin.messageTemplate.create({
      data: {
        tenantId,
        code: DUNNING_WHATSAPP_TEMPLATE_CODE,
        kind: 'transactional',
        channel: 'whatsapp',
        name: 'Recordatorio de pago por WhatsApp',
        bodyText: DUNNING_WHATSAPP_DEFAULT_TEXT,
        locale: 'es-ES',
        variables: [
          'customer.firstName',
          'invoice.number',
          'invoice.amountPending',
          'invoice.dueDate',
          'portal.url',
          'tenant.name',
        ],
        whatsappTemplateVariables: [...DUNNING_WHATSAPP_TEMPLATE_VARIABLES],
        metadata: { trigger: 'invoice_overdue' },
        ...data,
      },
    });
  }

  async update(
    tenantId: string,
    userId: string,
    input: DunningSettingsInput,
    meta: RequestMeta,
  ): Promise<DunningSettingsDto> {
    if (input.whatsappReminders === true) {
      const current = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { dunningWhatsappReminders: true },
      });
      if (!current?.dunningWhatsappReminders && !(await this.whatsappAvailable(tenantId))) {
        throw new BadRequestException({
          code: 'whatsapp_not_available',
          message:
            'Para mandar los recordatorios por WhatsApp, conecta y activa antes tu número en Configuración → WhatsApp.',
        });
      }
    }
    const data = {
      ...(input.whatsappReminders !== undefined
        ? { dunningWhatsappReminders: input.whatsappReminders }
        : {}),
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
    if (input.whatsappTemplateName !== undefined || input.whatsappTemplateLanguage !== undefined) {
      await this.saveWhatsappTemplate(
        tenantId,
        input.whatsappTemplateName,
        input.whatsappTemplateLanguage,
      );
    }
    await this.audit.write({
      tenantId,
      userId,
      action: 'tenant.dunning.settings_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        ...data,
        ...(input.whatsappTemplateName !== undefined
          ? { whatsappTemplateName: input.whatsappTemplateName }
          : {}),
        ...(input.whatsappTemplateLanguage !== undefined
          ? { whatsappTemplateLanguage: input.whatsappTemplateLanguage }
          : {}),
      } as unknown as Prisma.InputJsonValue,
      ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    });
    return this.get(tenantId);
  }
}
