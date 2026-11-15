import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_WINBACK_BODY,
  DEFAULT_WINBACK_SECOND_BODY,
  DEFAULT_WINBACK_SECOND_SUBJECT,
  DEFAULT_WINBACK_SUBJECT,
  WINBACK_SECOND_TEMPLATE_VARIABLES,
  WINBACK_TEMPLATE_VARIABLES,
  type UpdateWinbackSettingsInput,
  type WinbackPreviewDto,
  type WinbackRunResultDto,
  type WinbackSettingsResponse,
  type WinbackStatsDto,
} from '@storageos/shared';

import { FORMER_CONTRACT_WHERE, formerCustomerWhere } from '../../common/marketing/audience';
import { assertTemplateTexts } from '../../common/marketing/template-check';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { renderText } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { CampaignActor } from './campaigns.service';
import type { Prisma } from '@storageos/database';

const ALLOWED = WINBACK_TEMPLATE_VARIABLES;
const ALLOWED_SECOND = WINBACK_SECOND_TEMPLATE_VARIABLES;

interface Candidate {
  id: string;
  email: string;
  scope: Record<string, unknown>;
}

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
    private readonly audit: AuditService,
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
    actor?: CampaignActor,
  ): Promise<WinbackSettingsResponse> {
    // Una variable mal escrita daba un correo vacío (o ninguno) sin avisar.
    assertTemplateTexts(
      [
        { label: 'Asunto', text: input.subject },
        { label: 'Mensaje', text: input.bodyText },
      ],
      ALLOWED,
    );
    assertTemplateTexts(
      [
        { label: 'Asunto del segundo aviso', text: input.secondSubject },
        { label: 'Mensaje del segundo aviso', text: input.secondBodyText },
      ],
      ALLOWED_SECOND,
    );
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
      if (actor) {
        await this.audit.write({
          tenantId,
          userId: actor.userId,
          action: 'winback.settings_changed',
          entityType: 'Tenant',
          entityId: tenantId,
          changes: {
            fields: Object.entries(input)
              .filter(([, v]) => v !== undefined)
              .map(([k]) => k),
          },
          ipAddress: actor.meta.ipAddress ?? null,
          userAgent: actor.meta.userAgent ?? null,
        });
      }
    }
    return this.getSettings(tenantId);
  }

  /** A cuántos escribiría «Enviar ahora» (sin enviar nada). */
  async preview(tenantId: string): Promise<WinbackPreviewDto> {
    const t = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, winbackDelayDays: true },
    });
    const first = await this.firstStepCandidates(tenantId, t, true);
    const second = await this.secondStepCandidates(tenantId, t.name, true);
    return { firstStep: first.length, secondStep: second?.candidates.length ?? 0 };
  }

  /** «Enviar ahora» desde el panel (queda en el registro). */
  async runNow(tenantId: string, actor: CampaignActor): Promise<WinbackRunResultDto> {
    const res = await this.runForTenant(tenantId, true);
    await this.audit.write({
      tenantId,
      userId: actor.userId,
      action: 'winback.sent_now',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { ...res },
      ipAddress: actor.meta.ipAddress ?? null,
      userAgent: actor.meta.userAgent ?? null,
    });
    return res;
  }

  /**
   * Ex-clientes a los que toca el primer aviso: se fueron hace el plazo (y no
   * hace más de la ventana, salvo `force`), no se fueron debiendo, no se han
   * dado de baja y aún no lo recibieron. Una dirección, una vez.
   */
  private async firstStepCandidates(
    tenantId: string,
    t: { name: string; winbackDelayDays: number },
    force: boolean,
  ): Promise<Candidate[]> {
    const now = Date.now();
    const thresholdBefore = new Date(now - t.winbackDelayDays * DAY_MS); // se fue hace >= delay
    const windowAfter = force
      ? null
      : new Date(now - (t.winbackDelayDays + WINBACK_WINDOW_DAYS) * DAY_MS); // y <= delay+ventana
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: {
            AND: [
              {
                deletedAt: null,
                email: { not: null },
                // Es una comunicación comercial: no a quien se dio de baja.
                marketingOptOutAt: null,
                // Aún no se le ha enviado el win-back.
                winbackSends: { none: {} },
              },
              formerCustomerWhere(),
            ],
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            email: true,
            contracts: {
              where: FORMER_CONTRACT_WHERE,
              select: { endDate: true, updatedAt: true },
            },
          },
        }),
      tenantId,
    );
    const due = rows.filter((c) => {
      // Fecha de baja ≈ la más reciente entre sus contratos cerrados (endDate ?? updatedAt).
      const leftAt = c.contracts.reduce<Date | null>((max, k) => {
        const d = k.endDate ?? k.updatedAt;
        return !max || d > max ? d : max;
      }, null);
      if (!leftAt || leftAt > thresholdBefore) return false; // aún no ha pasado el plazo
      return !windowAfter || leftAt >= windowAfter; // demasiado antiguo (fuera de la ventana)
    });
    return this.candidates(tenantId, due, t.name);
  }

  /** Una dirección una sola vez y sin las que se dieron de baja o rebotan. */
  private async candidates(
    tenantId: string,
    rows: Array<{
      id: string;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      customerType: string;
    }>,
    tenantName: string,
  ): Promise<Candidate[]> {
    const unique = new Map<string, Candidate>();
    for (const c of rows) {
      if (!c.email) continue;
      const key = c.email.trim().toLowerCase();
      if (unique.has(key)) continue;
      unique.set(key, {
        id: c.id,
        email: c.email,
        scope: {
          customer: {
            firstName: c.firstName ?? '',
            lastName: c.lastName ?? '',
            displayName: this.displayName(c),
          },
          tenant: { name: tenantName },
        },
      });
    }
    if (unique.size === 0) return [];
    const emails = [...unique.keys()];
    const [opted, optedLeads, suppressed] = await Promise.all([
      this.admin.customer.findMany({
        where: {
          tenantId,
          marketingOptOutAt: { not: null },
          email: { in: emails, mode: 'insensitive' },
        },
        select: { email: true },
      }),
      this.admin.lead.findMany({
        where: {
          tenantId,
          marketingOptOutAt: { not: null },
          email: { in: emails, mode: 'insensitive' },
        },
        select: { email: true },
      }),
      this.admin.emailSuppression.findMany({
        where: { email: { in: emails }, OR: [{ tenantId }, { tenantId: null }] },
        select: { email: true },
      }),
    ]);
    for (const row of [...opted, ...optedLeads, ...suppressed]) {
      if (row.email) unique.delete(row.email.trim().toLowerCase());
    }
    return [...unique.values()];
  }

  /**
   * Prepara el correo, reserva el envío y lo encola. Si algo falla, se libera
   * la reserva: antes una variable mal escrita marcaba al ex-cliente como
   * avisado sin escribirle, y ya no se le escribía nunca.
   */
  private async sendOne(
    tenantId: string,
    c: Candidate,
    step: 1 | 2,
    subjectTpl: string,
    bodyTpl: string,
  ): Promise<boolean> {
    const allowed = step === 2 ? ALLOWED_SECOND : ALLOWED;
    let subject: string;
    let bodyText: string;
    try {
      subject = renderText(subjectTpl, c.scope, allowed);
      bodyText = renderText(bodyTpl, c.scope, allowed);
    } catch (err) {
      this.logger.warn(`[winback] el texto no se puede preparar: ${(err as Error).message}`);
      return false;
    }
    let reservedId: string;
    try {
      const reserved = await this.prisma.withTenant(
        (tx) => tx.winbackSend.create({ data: { tenantId, customerId: c.id, step } }),
        tenantId,
      );
      reservedId = reserved.id;
    } catch {
      return false; // ya enviado (único)
    }
    try {
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: c.email,
        subject,
        bodyText,
        customerId: c.id,
        source: step === 2 ? 'winback.second' : 'winback.auto',
        marketing: true,
      });
      return true;
    } catch (err) {
      await this.prisma
        .withTenant((tx) => tx.winbackSend.deleteMany({ where: { id: reservedId } }), tenantId)
        .catch(() => undefined);
      this.logger.warn(
        `[winback] ${c.email} falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
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

    const subjectTpl = t.winbackSubject || DEFAULT_WINBACK_SUBJECT;
    const bodyTpl = t.winbackBodyText || DEFAULT_WINBACK_BODY;
    let sent = 0;
    for (const c of await this.firstStepCandidates(tenantId, t, force)) {
      if (await this.sendOne(tenantId, c, 1, subjectTpl, bodyTpl)) sent += 1;
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
    const due = await this.secondStepCandidates(tenantId, tenantName, force);
    if (!due) return 0;
    let sent = 0;
    for (const c of due.candidates) {
      if (await this.sendOne(tenantId, c, 2, due.subjectTpl, due.bodyTpl)) sent += 1;
    }
    return sent;
  }

  /** Quien recibió el primer aviso hace el plazo y sigue sin volver; null si no toca. */
  private async secondStepCandidates(
    tenantId: string,
    tenantName: string,
    force: boolean,
  ): Promise<{ candidates: Candidate[]; subjectTpl: string; bodyTpl: string } | null> {
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
    if (!t.winbackSecondEnabled || !t.winbackSecondCouponCode) return null;
    const coupon = await this.admin.coupon.findFirst({
      where: { tenantId, code: t.winbackSecondCouponCode, isActive: true },
      select: { code: true, validUntil: true, maxUses: true, usedCount: true },
    });
    if (
      !coupon ||
      (coupon.validUntil && coupon.validUntil < new Date()) ||
      (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses)
    ) {
      this.logger.warn(`[winback] tenant=${tenantId}: el cupón del segundo aviso no se puede usar`);
      return null;
    }
    const before = new Date(Date.now() - t.winbackSecondDelayDays * DAY_MS);
    const after = force ? null : new Date(before.getTime() - WINBACK_WINDOW_DAYS * DAY_MS);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: {
            AND: [
              {
                deletedAt: null,
                email: { not: null },
                marketingOptOutAt: null,
                contracts: { none: { status: { in: ['active', 'ending'] }, deletedAt: null } },
              },
              {
                winbackSends: {
                  some: {
                    step: 1,
                    sentAt: { lte: before, ...(after ? { gte: after } : {}) },
                  },
                },
              },
              { winbackSends: { none: { step: 2 } } },
              formerCustomerWhere(),
            ],
          },
          orderBy: { createdAt: 'asc' },
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
    return {
      candidates: await this.candidates(tenantId, rows, tenantName),
      subjectTpl: t.winbackSecondSubject || DEFAULT_WINBACK_SECOND_SUBJECT,
      bodyTpl: (t.winbackSecondBodyText || DEFAULT_WINBACK_SECOND_BODY).replace(
        /\{\{\s*coupon\.code\s*\}\}/g,
        coupon.code,
      ),
    };
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
