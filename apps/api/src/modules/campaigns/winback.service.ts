import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_WINBACK_BODY,
  DEFAULT_WINBACK_SECOND_BODY,
  DEFAULT_WINBACK_SECOND_SUBJECT,
  DEFAULT_WINBACK_SUBJECT,
  type WinbackStatsDto,
  type UpdateWinbackSettingsInput,
  type WinbackRunResultDto,
  type WinbackSettingsResponse,
} from '@storageos/shared';

import { CommunicationsService } from '../communications/communications.service';
import { TEMPLATE_VARIABLES_BY_TRIGGER, renderText } from '../communications/template-engine';
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
        winbackSecondEnabled: true,
        winbackSecondDelayDays: true,
        winbackSecondSubject: true,
        winbackSecondBodyText: true,
        winbackSecondCouponCode: true,
      },
    });
    return {
      enabled: t.winbackEnabled,
      delayDays: t.winbackDelayDays,
      subject: t.winbackSubject,
      bodyText: t.winbackBodyText,
      secondEnabled: t.winbackSecondEnabled,
      secondDelayDays: t.winbackSecondDelayDays,
      secondSubject: t.winbackSecondSubject,
      secondBodyText: t.winbackSecondBodyText,
      secondCouponCode: t.winbackSecondCouponCode,
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
    if (input.secondEnabled !== undefined) data.winbackSecondEnabled = input.secondEnabled;
    if (input.secondDelayDays !== undefined) data.winbackSecondDelayDays = input.secondDelayDays;
    if (input.secondSubject !== undefined) data.winbackSecondSubject = input.secondSubject || null;
    if (input.secondBodyText !== undefined) {
      data.winbackSecondBodyText = input.secondBodyText || null;
    }
    if (input.secondCouponCode !== undefined) {
      const code = input.secondCouponCode.trim().toUpperCase();
      if (code) await this.assertUsableCoupon(tenantId, code);
      data.winbackSecondCouponCode = code || null;
    }
    if (input.secondEnabled) {
      const current = await this.admin.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { winbackSecondCouponCode: true },
      });
      const code =
        input.secondCouponCode !== undefined
          ? input.secondCouponCode.trim()
          : current.winbackSecondCouponCode;
      if (!code) {
        throw new BadRequestException({
          code: 'winback_coupon_required',
          message: 'Elige el cupón que se ofrece en el segundo aviso',
        });
      }
    }
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
    if (!t || !t.winbackEnabled) return { sent: 0, secondSent: 0 };

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
            // Es una comunicación comercial: no a quien se dio de baja.
            marketingOptOutAt: null,
            // Ex-cliente: tuvo un contrato terminado y no tiene ninguno vivo.
            contracts: {
              some: {
                status: { in: ['ended', 'cancelled'] },
                deletedAt: null,
                signedAt: { not: null },
              },
            },
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
              where: {
                status: { in: ['ended', 'cancelled'] },
                deletedAt: null,
                signedAt: { not: null },
              },
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
          subject: renderText(subjectTpl, scope, MANUAL_WHITELIST),
          bodyText: renderText(bodyTpl, scope, MANUAL_WHITELIST),
          customerId: c.id,
          source: 'winback.auto',
          marketing: true,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(
          `[winback] ${c.email} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sent > 0) this.logger.log(`[winback] tenant=${tenantId}: ${sent} oferta(s) de vuelta`);
    const secondSent = await this.runSecondStep(tenantId, t.name, force);
    return { sent, secondSent };
  }

  /**
   * Segundo aviso, con cupón, a quien recibió el primero hace `secondDelayDays`
   * y sigue sin volver. Una sola vez por cliente (`winback_sends.step = 2`).
   */
  private async runSecondStep(tenantId: string, tenantName: string, force: boolean) {
    const t = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        winbackSecondEnabled: true,
        winbackSecondDelayDays: true,
        winbackSecondSubject: true,
        winbackSecondBodyText: true,
        winbackSecondCouponCode: true,
      },
    });
    if (!t.winbackSecondEnabled || !t.winbackSecondCouponCode) return 0;
    const coupon = await this.admin.coupon.findFirst({
      where: { tenantId, code: t.winbackSecondCouponCode, isActive: true },
      select: { code: true, validUntil: true },
    });
    if (!coupon || (coupon.validUntil && coupon.validUntil < new Date())) {
      this.logger.warn(`[winback] tenant=${tenantId}: el cupón del segundo aviso no está activo`);
      return 0;
    }
    const before = new Date(Date.now() - t.winbackSecondDelayDays * DAY_MS);
    const after = force ? null : new Date(before.getTime() - WINBACK_WINDOW_DAYS * DAY_MS);
    const candidates = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: {
            deletedAt: null,
            email: { not: null },
            marketingOptOutAt: null,
            contracts: { none: { status: { in: ['active', 'ending'] }, deletedAt: null } },
            AND: [
              {
                winbackSends: {
                  some: {
                    step: 1,
                    sentAt: { lte: before, ...(after ? { gte: after } : {}) },
                  },
                },
              },
              { winbackSends: { none: { step: 2 } } },
            ],
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            email: true,
          },
        }),
      tenantId,
    );
    const subjectTpl = t.winbackSecondSubject || DEFAULT_WINBACK_SECOND_SUBJECT;
    const bodyTpl = (t.winbackSecondBodyText || DEFAULT_WINBACK_SECOND_BODY).replace(
      /\{\{\s*coupon\.code\s*\}\}/g,
      coupon.code,
    );
    let sent = 0;
    for (const c of candidates) {
      if (!c.email) continue;
      try {
        await this.prisma.withTenant(
          (tx) => tx.winbackSend.create({ data: { tenantId, customerId: c.id, step: 2 } }),
          tenantId,
        );
      } catch {
        continue;
      }
      const scope = {
        customer: {
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          displayName: this.displayName(c),
        },
        tenant: { name: tenantName },
      };
      try {
        await this.communications.enqueue({
          tenantId,
          channel: 'email',
          recipient: c.email,
          subject: renderText(subjectTpl, scope, MANUAL_WHITELIST),
          bodyText: renderText(bodyTpl, scope, MANUAL_WHITELIST),
          customerId: c.id,
          source: 'winback.second',
          marketing: true,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(
          `[winback] 2º aviso ${c.email} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent;
  }

  /** Cuántos recibieron el win-back y cuántos volvieron a firmar después. */
  async stats(tenantId: string): Promise<WinbackStatsDto> {
    return this.prisma.withTenant(async (tx) => {
      const sends = await tx.winbackSend.findMany({
        select: { customerId: true, step: true, sentAt: true },
      });
      const first = new Map<string, Date>();
      let secondSent = 0;
      for (const s of sends) {
        if (s.step === 1) first.set(s.customerId, s.sentAt);
        else secondSent += 1;
      }
      let recovered = 0;
      if (first.size > 0) {
        const signed = await tx.contract.findMany({
          where: {
            customerId: { in: [...first.keys()] },
            signedAt: { not: null },
            deletedAt: null,
          },
          select: { customerId: true, signedAt: true },
        });
        const back = new Set<string>();
        for (const c of signed) {
          const at = first.get(c.customerId);
          if (at && c.signedAt && c.signedAt > at) back.add(c.customerId);
        }
        recovered = back.size;
      }
      return {
        firstSent: first.size,
        secondSent,
        recovered,
        recoveryRate: first.size ? Math.round((recovered / first.size) * 1000) / 10 : null,
      };
    }, tenantId);
  }

  private async assertUsableCoupon(tenantId: string, code: string): Promise<void> {
    const coupon = await this.admin.coupon.findFirst({
      where: { tenantId, code },
      select: { isActive: true, newCustomersOnly: true },
    });
    if (!coupon || !coupon.isActive) {
      throw new BadRequestException({
        code: 'coupon_not_found',
        message: 'No hay ningún cupón activo con ese código',
      });
    }
    if (coupon.newCustomersOnly) {
      throw new BadRequestException({
        code: 'coupon_new_customers_only',
        message: 'Ese cupón es solo para clientes nuevos y un ex-cliente no podría usarlo',
      });
    }
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
        const res = await this.runForTenant(t.id);
        sent += res.sent + res.secondSent;
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
