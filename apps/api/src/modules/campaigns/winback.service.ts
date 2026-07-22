import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_WINBACK_BODY,
  DEFAULT_WINBACK_SUBJECT,
  type UpdateWinbackSettingsInput,
  type WinbackRunResultDto,
  type WinbackSettingsResponse,
} from '@storageos/shared';

import { CommunicationsService } from '../communications/communications.service';
import { TEMPLATE_VARIABLES_BY_TRIGGER, renderTemplate } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';

const MANUAL_WHITELIST = TEMPLATE_VARIABLES_BY_TRIGGER.manual;

/**
 * Ventana de captura tras cruzar el umbral: al activar la feature (o si el cron
 * se salta días) solo se contacta a quien se fue en `[delayDays, delayDays +
 * WINDOW]`, para no reenviar de golpe a ex-clientes muy antiguos. La idempotencia
 * la garantiza `winback_sends` (un envío por cliente); esto solo acota el arranque.
 */
const WINBACK_WINDOW_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Win-back automático de bajas: N días después de que un inquilino se va (sin
 * contrato activo), le envía por email una oferta de vuelta. Opt-in por tenant,
 * un solo envío por cliente (tabla `winback_sends`). Reutiliza el outbox de
 * communications, como las campañas.
 */
@Injectable()
export class WinbackService {
  private readonly logger = new Logger(WinbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
  ) {}

  async getSettings(tenantId: string): Promise<WinbackSettingsResponse> {
    const t = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        winbackEnabled: true,
        winbackDelayDays: true,
        winbackSubject: true,
        winbackBodyText: true,
      },
    });
    return {
      enabled: t.winbackEnabled,
      delayDays: t.winbackDelayDays,
      subject: t.winbackSubject,
      bodyText: t.winbackBodyText,
    };
  }

  async updateSettings(
    tenantId: string,
    input: UpdateWinbackSettingsInput,
  ): Promise<WinbackSettingsResponse> {
    const data: Prisma.TenantUpdateInput = {};
    if (input.enabled !== undefined) data.winbackEnabled = input.enabled;
    if (input.delayDays !== undefined) data.winbackDelayDays = input.delayDays;
    if (input.subject !== undefined) data.winbackSubject = input.subject || null;
    if (input.bodyText !== undefined) data.winbackBodyText = input.bodyText || null;
    if (Object.keys(data).length > 0) {
      await this.admin.tenant.update({ where: { id: tenantId }, data });
    }
    return this.getSettings(tenantId);
  }

  /**
   * Envía la oferta de vuelta a los ex-clientes que cumplen el umbral y aún no la
   * recibieron. `force` (uso desde «enviar ahora») ignora la ventana de captura.
   */
  async runForTenant(tenantId: string, force = false): Promise<WinbackRunResultDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        winbackEnabled: true,
        winbackDelayDays: true,
        winbackSubject: true,
        winbackBodyText: true,
      },
    });
    if (!t || !t.winbackEnabled) return { sent: 0 };

    const now = Date.now();
    const thresholdBefore = new Date(now - t.winbackDelayDays * DAY_MS); // se fue hace >= delay
    const windowAfter = force
      ? null
      : new Date(now - (t.winbackDelayDays + WINBACK_WINDOW_DAYS) * DAY_MS); // y <= delay+ventana

    const subjectTpl = t.winbackSubject || DEFAULT_WINBACK_SUBJECT;
    const bodyTpl = t.winbackBodyText || DEFAULT_WINBACK_BODY;

    const candidates = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: {
            deletedAt: null,
            email: { not: null },
            // Ex-cliente: tuvo un contrato terminado y no tiene ninguno vivo.
            contracts: { some: { status: { in: ['ended', 'cancelled'] }, deletedAt: null } },
            AND: [
              { contracts: { none: { status: { in: ['active', 'ending'] }, deletedAt: null } } },
            ],
            // Aún no se le ha enviado el win-back.
            winbackSends: { none: {} },
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            email: true,
            contracts: {
              where: { status: { in: ['ended', 'cancelled'] }, deletedAt: null },
              select: { endDate: true, updatedAt: true },
            },
          },
        }),
      tenantId,
    );

    let sent = 0;
    for (const c of candidates) {
      if (!c.email) continue;
      // Fecha de baja ≈ la más reciente entre sus contratos cerrados (endDate ?? updatedAt).
      const leftAt = c.contracts.reduce<Date | null>((max, k) => {
        const d = k.endDate ?? k.updatedAt;
        return !max || d > max ? d : max;
      }, null);
      if (!leftAt) continue;
      if (leftAt > thresholdBefore) continue; // aún no ha pasado el plazo
      if (windowAfter && leftAt < windowAfter) continue; // demasiado antiguo (fuera de la ventana)

      // Reserva el envío ANTES de encolar (idempotente; una carrera lo salta).
      try {
        await this.prisma.withTenant(
          (tx) => tx.winbackSend.create({ data: { tenantId, customerId: c.id } }),
          tenantId,
        );
      } catch {
        continue; // ya enviado (unique)
      }

      const scope = {
        customer: {
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          displayName: this.displayName(c),
        },
        tenant: { name: t.name },
      };
      try {
        await this.communications.enqueue({
          tenantId,
          channel: 'email',
          recipient: c.email,
          subject: renderTemplate(subjectTpl, scope, MANUAL_WHITELIST),
          bodyText: renderTemplate(bodyTpl, scope, MANUAL_WHITELIST),
          customerId: c.id,
          source: 'winback.auto',
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(
          `[winback] ${c.email} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sent > 0) this.logger.log(`[winback] tenant=${tenantId}: ${sent} oferta(s) de vuelta`);
    return { sent };
  }

  /** Ejecución cross-tenant (cron): todos los tenants con la feature activa. */
  async runDueAll(): Promise<{ tenants: number; sent: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, winbackEnabled: true },
      select: { id: true },
    });
    let sent = 0;
    for (const t of tenants) {
      try {
        sent += (await this.runForTenant(t.id)).sent;
      } catch (err) {
        this.logger.warn(
          `[winback] tenant ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { tenants: tenants.length, sent };
  }

  private displayName(c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  }): string {
    if (c.customerType === 'business') return c.companyName ?? 'Cliente';
    return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
  }
}
