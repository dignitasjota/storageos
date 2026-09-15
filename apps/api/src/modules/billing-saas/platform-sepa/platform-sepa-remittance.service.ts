import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { toCents } from '../../../common/money';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { buildPain008, type Pain008Transaction } from '../../sepa/sepa-pain008';
import { BillingSaasService } from '../billing-saas.service';
import { SaasAddonsService } from '../saas-addons.service';

import type { Prisma } from '@storageos/database';
import type {
  CreatePlatformSepaRemittanceInput,
  PlatformSepaEligibleTenantDto,
  PlatformSepaRemittanceDto,
  PlatformSepaRemittancePreviewDto,
} from '@storageos/shared';

/** AAD fijo para el IBAN del acreedor de plataforma (sin scope de tenant). */
const CREDITOR_AAD = 'platform-sepa-settings';
/** Días de margen antes del vencimiento para poder generar la remesa (D+2 mínimo típico de SEPA CORE). */
const GRACE_DAYS_AHEAD = 5;

function rand(n = 6): string {
  return randomBytes(n).toString('hex').toUpperCase().slice(0, n);
}

/** Trunca a fecha (medianoche UTC) — consistencia con la columna `@db.Date`. */
function toDateOnly(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

type MandateRow = {
  id: string;
  reference: string;
  ibanEncrypted: string;
  bic: string | null;
  signedAt: Date;
  sequenceType: string;
};

interface EligibleCandidate {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  periodCovered: Date;
  amount: number;
  mandate: MandateRow;
}

/**
 * Remesa SEPA de PLATAFORMA: genera el pain.008 que domicilia la cuota de
 * los tenants en modo `billingMode='sepa'` y confirma su cobro reutilizando
 * `BillingSaasService.recordManualPayment` (misma extensión de periodo +
 * candado + dedup que ya usa el pago manual, sin reimplementar nada).
 */
@Injectable()
export class PlatformSepaRemittanceService {
  private readonly logger = new Logger(PlatformSepaRemittanceService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly saasAddons: SaasAddonsService,
    private readonly billingSaas: BillingSaasService,
  ) {}

  /**
   * Importe a domiciliar: plan + add-ons NO suspendidos y NO ya cobrados por
   * su propio subscription item de Stripe (evita el doble cobro — un add-on
   * en billingMode='stripe' se cobra aparte, no aquí).
   */
  private async eligibleAmount(tenantId: string): Promise<number> {
    const summary = await this.saasAddons.billingSummary(tenantId);
    const nonStripeAddons = summary.addons
      .filter((a) => !a.suspended && a.billingMode !== 'stripe')
      .reduce((s, a) => s + a.lineTotal, 0);
    return Math.round((summary.planMonthly + nonStripeAddons) * 100) / 100;
  }

  private async eligible(): Promise<{
    candidates: EligibleCandidate[];
    withoutMandate: { tenantId: string; tenantName: string }[];
  }> {
    const graceDate = new Date(Date.now() + GRACE_DAYS_AHEAD * 24 * 60 * 60 * 1000);
    const subs = await this.admin.tenantSubscription.findMany({
      where: {
        billingMode: 'sepa',
        status: { in: ['active', 'past_due'] },
        currentPeriodEnd: { lte: graceDate },
      },
      include: { tenant: { select: { id: true, slug: true, name: true } } },
    });
    if (subs.length === 0) return { candidates: [], withoutMandate: [] };

    const tenantIds = subs.map((s) => s.tenantId);
    const [mandates, existingItems] = await Promise.all([
      this.admin.platformSepaMandate.findMany({
        where: { tenantId: { in: tenantIds }, status: 'active' },
      }),
      this.admin.platformSepaRemittanceItem.findMany({
        where: { tenantId: { in: tenantIds }, itemStatus: { in: ['pending', 'collected'] } },
        select: { tenantId: true, periodCovered: true },
      }),
    ]);
    const mandateByTenant = new Map(mandates.map((m) => [m.tenantId, m]));
    const blockedKey = new Set(
      existingItems.map((i) => `${i.tenantId}:${i.periodCovered.toISOString().slice(0, 10)}`),
    );

    const candidates: EligibleCandidate[] = [];
    const withoutMandate: { tenantId: string; tenantName: string }[] = [];
    for (const sub of subs) {
      const mandate = mandateByTenant.get(sub.tenantId);
      if (!mandate) {
        withoutMandate.push({ tenantId: sub.tenantId, tenantName: sub.tenant.name });
        continue;
      }
      const periodCovered = toDateOnly(sub.currentPeriodEnd);
      const key = `${sub.tenantId}:${periodCovered.toISOString().slice(0, 10)}`;
      if (blockedKey.has(key)) continue;
      const amount = await this.eligibleAmount(sub.tenantId);
      if (amount <= 0) continue;
      candidates.push({
        tenantId: sub.tenantId,
        tenantSlug: sub.tenant.slug,
        tenantName: sub.tenant.name,
        periodCovered,
        amount,
        mandate,
      });
    }
    return { candidates, withoutMandate };
  }

  async previewRemittance(): Promise<PlatformSepaRemittancePreviewDto> {
    const { candidates, withoutMandate } = await this.eligible();
    const eligible: PlatformSepaEligibleTenantDto[] = candidates.map((c) => ({
      tenantId: c.tenantId,
      tenantName: c.tenantName,
      periodCovered: c.periodCovered.toISOString().slice(0, 10),
      amount: c.amount,
      mandateReference: c.mandate.reference,
      ibanLast4: '', // no se decripta en el preview; ver detalle de la remesa creada.
      sequenceType: c.mandate.sequenceType as 'FRST' | 'RCUR',
    }));
    const total = eligible.reduce((s, e) => s + toCents(e.amount), 0) / 100;
    return { eligible, total, withoutMandate };
  }

  async createRemittance(args: {
    superAdminId: string;
    input: CreatePlatformSepaRemittanceInput;
  }): Promise<PlatformSepaRemittanceDto> {
    const settings = await this.admin.platformSepaSettings.findFirst();
    if (!settings?.enabled || !settings.creditorIbanEncrypted) {
      throw new BadRequestException({
        code: 'sepa_not_configured',
        message: 'Configura primero el acreedor SEPA de la plataforma',
      });
    }
    const { candidates } = await this.eligible();
    const selected = args.input.tenantIds
      ? candidates.filter((c) => args.input.tenantIds!.includes(c.tenantId))
      : candidates;
    if (selected.length === 0) {
      throw new BadRequestException({
        code: 'no_eligible_tenants',
        message: 'No hay tenants domiciliables con mandato activo',
      });
    }

    const messageId = `REM-SAAS-${Date.now().toString(36).toUpperCase()}-${rand()}`;
    const remittance = await this.admin.platformSepaRemittance.create({
      data: {
        name: args.input.name,
        messageId,
        collectionDate: toDateOnly(new Date(`${args.input.collectionDate}T00:00:00Z`)),
        status: 'generated',
        createdBySuperAdminId: args.superAdminId,
      },
    });

    // Best-effort por tenant: una colisión de unicidad (tenant, periodo) —
    // p.ej. otra remesa creada justo antes para el mismo tenant — se
    // descarta sin abortar el lote entero, igual que `confirmRemittance` del
    // módulo tenant-facing hace por item.
    const committed: EligibleCandidate[] = [];
    for (const c of selected) {
      try {
        await this.admin.platformSepaRemittanceItem.create({
          data: {
            remittanceId: remittance.id,
            tenantId: c.tenantId,
            mandateId: c.mandate.id,
            amount: toCents(c.amount),
            sequenceType: c.mandate.sequenceType,
            endToEndId: `E2E-SAAS-${c.tenantSlug}-${c.periodCovered.toISOString().slice(0, 10)}`
              .replace(/[^A-Za-z0-9-]/g, '')
              .slice(0, 35),
            periodCovered: c.periodCovered,
          },
        });
        committed.push(c);
      } catch (err) {
        this.logger.warn(
          `[platform-sepa] item de remesa para tenant ${c.tenantId} colisionó, se omite: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (committed.length === 0) {
      await this.admin.platformSepaRemittance.delete({ where: { id: remittance.id } });
      throw new BadRequestException({
        code: 'no_eligible_tenants',
        message: 'No hay tenants domiciliables con mandato activo',
      });
    }

    const creditorIban = this.crypto.decryptString(settings.creditorIbanEncrypted, CREDITOR_AAD);
    const txs: Pain008Transaction[] = committed.map((c) => ({
      endToEndId: `E2E-SAAS-${c.tenantSlug}-${c.periodCovered.toISOString().slice(0, 10)}`
        .replace(/[^A-Za-z0-9-]/g, '')
        .slice(0, 35),
      amountCents: toCents(c.amount),
      mandateReference: c.mandate.reference,
      mandateSignedDate: c.mandate.signedAt.toISOString().slice(0, 10),
      sequenceType: c.mandate.sequenceType as 'FRST' | 'RCUR',
      debtorName: c.tenantName,
      debtorIban: this.crypto.decryptString(c.mandate.ibanEncrypted, c.tenantId),
      debtorBic: c.mandate.bic,
      remittanceInfo: `Suscripcion TrasterOS ${c.periodCovered.toISOString().slice(0, 10)}`,
    }));
    const xml = buildPain008({
      messageId,
      creditor: {
        name: settings.creditorName,
        creditorId: settings.creditorId,
        iban: creditorIban,
        bic: settings.creditorBic,
      },
      collectionDate: args.input.collectionDate,
      transactions: txs,
    });
    const totalCents = committed.reduce((s, c) => s + toCents(c.amount), 0);
    const updated = await this.admin.platformSepaRemittance.update({
      where: { id: remittance.id },
      data: { xml, itemCount: committed.length, totalAmount: totalCents },
    });
    return this.toDto(updated, settings.updatedAt);
  }

  async listRemittances(): Promise<PlatformSepaRemittanceDto[]> {
    const [rows, settings] = await Promise.all([
      this.admin.platformSepaRemittance.findMany({ orderBy: { createdAt: 'desc' } }),
      this.admin.platformSepaSettings.findFirst(),
    ]);
    return rows.map((r) => this.toDto(r, settings?.updatedAt));
  }

  async getRemittance(id: string): Promise<PlatformSepaRemittanceDto> {
    const [r, settings, items] = await Promise.all([
      this.findOrThrow(id),
      this.admin.platformSepaSettings.findFirst(),
      this.admin.platformSepaRemittanceItem.findMany({
        where: { remittanceId: id },
        include: { tenant: { select: { name: true } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    return {
      ...this.toDto(r, settings?.updatedAt),
      items: items.map((i) => ({
        id: i.id,
        tenantId: i.tenantId,
        tenantName: i.tenant.name,
        amount: i.amount / 100,
        periodCovered: i.periodCovered.toISOString().slice(0, 10),
        itemStatus: i.itemStatus as 'pending' | 'collected' | 'bounced',
        bouncedAt: i.bouncedAt?.toISOString() ?? null,
        bounceReason: i.bounceReason,
      })),
    };
  }

  async getXml(id: string): Promise<{ filename: string; xml: string }> {
    const r = await this.findOrThrow(id);
    if (!r.xml) {
      throw new NotFoundException({ code: 'xml_not_found', message: 'La remesa no tiene XML' });
    }
    return { filename: `remesa-sepa-plataforma-${r.messageId}.xml`, xml: r.xml };
  }

  /** Confirma el cobro: registra el pago (extiende el periodo) por cada item y rota FRST→RCUR. */
  async confirmRemittance(id: string): Promise<PlatformSepaRemittanceDto> {
    const remittance = await this.findOrThrow(id);
    if (remittance.status !== 'generated') {
      throw new BadRequestException({
        code: 'remittance_not_confirmable',
        message: 'La remesa ya está confirmada o cancelada',
      });
    }
    const items = await this.admin.platformSepaRemittanceItem.findMany({
      where: { remittanceId: id },
    });
    for (const item of items) {
      try {
        await this.billingSaas.recordManualPayment({
          tenantId: item.tenantId,
          provider: 'sepa',
          amount: item.amount / 100,
          currency: 'EUR',
          durationMonths: 1,
          extendsPeriod: true,
          description: `Remesa SEPA plataforma ${remittance.name}`,
        });
        await this.admin.platformSepaRemittanceItem.update({
          where: { id: item.id },
          data: { itemStatus: 'collected' },
        });
      } catch (err) {
        this.logger.warn(
          `[platform-sepa] confirmar item ${item.id} (tenant ${item.tenantId}) falló: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // El primer cobro con éxito de un mandato pasa de FRST a RCUR.
    const mandateIds = [...new Set(items.map((i) => i.mandateId))];
    await this.admin.platformSepaMandate.updateMany({
      where: { id: { in: mandateIds }, sequenceType: 'FRST', status: 'active' },
      data: { sequenceType: 'RCUR' },
    });
    const updated = await this.admin.platformSepaRemittance.update({
      where: { id },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    return this.toDto(updated);
  }

  /**
   * Marca un item ya cobrado como devuelto por el banco (R-transaction) y
   * fuerza `past_due` en la suscripción del tenant. Es el único punto sin
   * webhook: `recordManualPayment` ya adelantó `currentPeriodEnd` al
   * confirmar, así que el cron `markLapsedManualPastDue` no lo detectaría
   * hasta el SIGUIENTE vencimiento (semanas después). No se revierte el
   * periodo/pago ya registrado — el bounce solo comunica "ahora está
   * retroactivamente al día"; `PlatformDunningService.run()` recoge el
   * `past_due` sin ningún cambio en ese servicio (ya es agnóstico del
   * origen del impago).
   */
  async markBounced(itemId: string, reason?: string): Promise<void> {
    const item = await this.admin.platformSepaRemittanceItem.findUnique({
      where: { id: itemId },
    });
    if (!item) {
      throw new NotFoundException({ code: 'item_not_found', message: 'Item no encontrado' });
    }
    if (item.itemStatus !== 'collected') {
      throw new BadRequestException({
        code: 'item_not_collected',
        message: 'Solo se puede marcar como devuelto un item ya cobrado',
      });
    }
    await this.admin.platformSepaRemittanceItem.update({
      where: { id: itemId },
      data: { itemStatus: 'bounced', bouncedAt: new Date(), bounceReason: reason ?? null },
    });
    await this.admin.tenantSubscription.update({
      where: { tenantId: item.tenantId },
      data: { status: 'past_due' },
    });
  }

  private async findOrThrow(id: string) {
    const row = await this.admin.platformSepaRemittance.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({
        code: 'remittance_not_found',
        message: 'Remesa no encontrada',
      });
    }
    return row;
  }

  private toDto(
    r: Prisma.PlatformSepaRemittanceGetPayload<object>,
    creditorUpdatedAt?: Date,
  ): PlatformSepaRemittanceDto {
    return {
      id: r.id,
      name: r.name,
      messageId: r.messageId,
      collectionDate: r.collectionDate.toISOString().slice(0, 10),
      status: r.status as PlatformSepaRemittanceDto['status'],
      itemCount: r.itemCount,
      total: r.totalAmount / 100,
      createdAt: r.createdAt.toISOString(),
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      creditorMayBeStale:
        r.status === 'generated' && !!creditorUpdatedAt && creditorUpdatedAt > r.createdAt,
    };
  }
}
