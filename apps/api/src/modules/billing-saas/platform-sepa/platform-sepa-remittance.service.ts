import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { toCents } from '../../../common/money';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { buildPain008, type Pain008Transaction } from '../../sepa/sepa-pain008';
import { BillingSaasService } from '../billing-saas.service';
import { amountToCharge, platformPricing } from '../platform-pricing';
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
  /** Adeudos ya devueltos de este periodo: el reintento lleva otro EndToEndId. */
  retries: number;
}

/**
 * EndToEndId del adeudo (máx. 35 caracteres SEPA). Un reintento tras una
 * devolución lleva `-R<n>`: así no se confunde con el cobro devuelto al
 * reanudar una confirmación.
 */
export function platformEndToEndId(slug: string, periodCovered: Date, retries: number): string {
  const date = periodCovered.toISOString().slice(0, 10);
  const suffix = retries > 0 ? `-R${retries}` : '';
  const prefix = 'E2E-SAAS-';
  const cleanSlug = slug.replace(/[^A-Za-z0-9-]/g, '');
  const room = 35 - prefix.length - 1 - date.length - suffix.length;
  return `${prefix}${cleanSlug.slice(0, Math.max(0, room))}-${date}${suffix}`;
}

/**
 * Remesa SEPA de PLATAFORMA: genera el pain.008 que domicilia la cuota de
 * los tenants en modo `billingMode='sepa'` y confirma su cobro reutilizando
 * `BillingSaasService.recordManualPayment` (misma extensión de periodo +
 * candado + dedup que ya usa el pago manual, sin reimplementar nada).
 */
/** Una confirmación cortada a medias se puede reanudar pasado este tiempo. */
const RESUME_AFTER_MS = 5 * 60_000;

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
    // Con precios +IVA se domicilia el precio más el IVA.
    return amountToCharge(summary.planMonthly + nonStripeAddons, await platformPricing(this.admin));
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
        where: { tenantId: { in: tenantIds } },
        select: { tenantId: true, periodCovered: true, itemStatus: true },
      }),
    ]);
    const mandateByTenant = new Map(mandates.map((m) => [m.tenantId, m]));
    const keyOf = (tenantId: string, d: Date) => `${tenantId}:${d.toISOString().slice(0, 10)}`;
    const blockedKey = new Set(
      existingItems
        .filter((i) => i.itemStatus === 'pending' || i.itemStatus === 'collected')
        .map((i) => keyOf(i.tenantId, i.periodCovered)),
    );
    const bouncedByKey = new Map<string, number>();
    for (const i of existingItems) {
      if (i.itemStatus !== 'bounced') continue;
      const k = keyOf(i.tenantId, i.periodCovered);
      bouncedByKey.set(k, (bouncedByKey.get(k) ?? 0) + 1);
    }

    const candidates: EligibleCandidate[] = [];
    const withoutMandate: { tenantId: string; tenantName: string }[] = [];
    for (const sub of subs) {
      const mandate = mandateByTenant.get(sub.tenantId);
      if (!mandate) {
        withoutMandate.push({ tenantId: sub.tenantId, tenantName: sub.tenant.name });
        continue;
      }
      const periodCovered = toDateOnly(sub.currentPeriodEnd);
      const key = keyOf(sub.tenantId, periodCovered);
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
        retries: bouncedByKey.get(key) ?? 0,
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
            endToEndId: platformEndToEndId(c.tenantSlug, c.periodCovered, c.retries),
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
      endToEndId: platformEndToEndId(c.tenantSlug, c.periodCovered, c.retries),
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
    return this.toDto(updated, settings.updatedAt, updated.itemCount);
  }

  async listRemittances(): Promise<PlatformSepaRemittanceDto[]> {
    const [rows, settings, pending] = await Promise.all([
      this.admin.platformSepaRemittance.findMany({ orderBy: { createdAt: 'desc' } }),
      this.admin.platformSepaSettings.findFirst(),
      this.admin.platformSepaRemittanceItem.groupBy({
        by: ['remittanceId'],
        where: { itemStatus: 'pending' },
        _count: { _all: true },
      }),
    ]);
    const pendingBy = new Map(pending.map((p) => [p.remittanceId, p._count._all]));
    return rows.map((r) => this.toDto(r, settings?.updatedAt, pendingBy.get(r.id) ?? 0));
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
      ...this.toDto(r, settings?.updatedAt, items.filter((i) => i.itemStatus === 'pending').length),
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

  /**
   * Confirma el cobro: registra el pago (extiende el periodo) por cada item y
   * rota FRST→RCUR. La remesa se reserva antes de cobrar (un doble clic no
   * cobra dos veces) y solo se procesan los items pendientes: si la
   * confirmación se cortó a medias, se puede reanudar pasados unos minutos.
   */
  async confirmRemittance(id: string): Promise<PlatformSepaRemittanceDto> {
    const remittance = await this.findOrThrow(id);
    await this.claimConfirmation(remittance);
    const items = await this.admin.platformSepaRemittanceItem.findMany({
      where: { remittanceId: id, itemStatus: 'pending' },
    });
    for (const item of items) {
      try {
        // Reanudación: el pago de este item ya se registró (la confirmación
        // anterior se cortó justo después): solo falta enlazarlo.
        const existing = await this.admin.tenantSubscriptionPayment.findFirst({
          where: {
            tenantId: item.tenantId,
            provider: 'sepa',
            description: { contains: item.endToEndId },
          },
          select: { id: true },
        });
        const payment =
          existing ??
          (await this.billingSaas.recordManualPayment({
            tenantId: item.tenantId,
            provider: 'sepa',
            amount: item.amount / 100,
            currency: 'EUR',
            durationMonths: 1,
            extendsPeriod: true,
            description: `Remesa SEPA plataforma ${remittance.name} · ${item.endToEndId}`,
          }));
        await this.admin.platformSepaRemittanceItem.updateMany({
          where: { id: item.id, itemStatus: 'pending' },
          data: { itemStatus: 'collected', paymentId: payment.id },
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
    const updated = await this.findOrThrow(id);
    return this.toDto(updated, undefined, await this.pendingCount(id));
  }

  /** Reserva la confirmación (o la reanuda si se cortó hace más de unos minutos). */
  private async claimConfirmation(remittance: {
    id: string;
    status: string;
    confirmedAt: Date | null;
  }): Promise<void> {
    const { count } = await this.admin.platformSepaRemittance.updateMany({
      where: { id: remittance.id, status: 'generated' },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    if (count === 1) return;
    if (
      remittance.status === 'confirmed' &&
      remittance.confirmedAt &&
      (await this.pendingCount(remittance.id)) > 0
    ) {
      if (Date.now() - remittance.confirmedAt.getTime() < RESUME_AFTER_MS) {
        throw new BadRequestException({
          code: 'remittance_confirming',
          message:
            'La remesa se está confirmando. Si se interrumpió, vuelve a intentarlo en unos minutos.',
        });
      }
      const resumed = await this.admin.platformSepaRemittance.updateMany({
        where: { id: remittance.id, status: 'confirmed', confirmedAt: remittance.confirmedAt },
        data: { confirmedAt: new Date() },
      });
      if (resumed.count === 1) return;
    }
    throw new BadRequestException({
      code: 'remittance_not_confirmable',
      message: 'La remesa ya está confirmada o cancelada',
    });
  }

  private pendingCount(remittanceId: string): Promise<number> {
    return this.admin.platformSepaRemittanceItem.count({
      where: { remittanceId, itemStatus: 'pending' },
    });
  }

  /**
   * Marca un item ya cobrado como devuelto por el banco (R-transaction): el
   * dinero no llegó, así que se deshace lo que hizo la confirmación. El periodo
   * que pagaba ese adeudo se retira de la suscripción (la siguiente remesa lo
   * vuelve a domiciliar), el cobro queda devuelto y su factura, abonada. Si con
   * eso el periodo ya venció, la suscripción pasa a `past_due` y entra en el
   * cobro de morosos.
   */
  async markBounced(itemId: string, reason?: string): Promise<void> {
    const now = new Date();
    const item = await this.admin.$transaction(async (tx) => {
      // Fila bloqueada: dos «Marcar como devuelto» a la vez no retiran dos meses.
      await tx.$queryRaw`SELECT id FROM platform_sepa_remittance_items WHERE id = ${itemId}::uuid FOR UPDATE`;
      const row = await tx.platformSepaRemittanceItem.findUnique({
        where: { id: itemId },
        include: { payment: { select: { periodStart: true, periodEnd: true } } },
      });
      if (!row) {
        throw new NotFoundException({ code: 'item_not_found', message: 'Item no encontrado' });
      }
      if (row.itemStatus !== 'collected') {
        throw new BadRequestException({
          code: 'item_not_collected',
          message: 'Solo se puede marcar como devuelto un item ya cobrado',
        });
      }
      await tx.platformSepaRemittanceItem.update({
        where: { id: itemId },
        data: { itemStatus: 'bounced', bouncedAt: now, bounceReason: reason ?? null },
      });
      const sub = await tx.tenantSubscription.findUniqueOrThrow({
        where: { tenantId: row.tenantId },
        select: { currentPeriodEnd: true },
      });
      // Lo que el cobro sumó al periodo. Si después no se pagó nada más, el fin
      // vuelve exactamente a donde estaba; si hubo pagos posteriores, se resta
      // solo lo de este.
      const paidStart = row.payment?.periodStart;
      const paidEnd = row.payment?.periodEnd;
      let periodEnd = sub.currentPeriodEnd;
      if (paidStart && paidEnd && paidEnd > paidStart) {
        periodEnd =
          sub.currentPeriodEnd.getTime() === paidEnd.getTime()
            ? paidStart
            : new Date(sub.currentPeriodEnd.getTime() - (paidEnd.getTime() - paidStart.getTime()));
      }
      await tx.tenantSubscription.update({
        where: { tenantId: row.tenantId },
        data: {
          currentPeriodEnd: periodEnd,
          ...(periodEnd <= now ? { status: 'past_due' as const } : {}),
        },
      });
      return row;
    });
    // El dinero no llegó: el cobro queda devuelto y su factura, abonada.
    if (item.paymentId) {
      await this.billingSaas
        .syncSubscriptionRefund(item.paymentId, item.amount / 100, 'Adeudo SEPA devuelto')
        .catch((err) =>
          this.logger.warn(
            `[platform-sepa] abono del adeudo devuelto ${item.id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
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
    pendingCount = 0,
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
      pendingCount,
    };
  }
}
