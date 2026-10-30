import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  isSepaMandateExpired,
  isValidCreditorId,
  nextSepaBusinessDay,
  requiredPrenoticeDays,
} from '@storageos/shared';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { formatDateLong, formatEur, todayInTimezone } from '../../../common/format';
import { toCents } from '../../../common/money';
import { assertCollectionDate } from '../../../common/sepa-mandate/collection-date';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { EmailService } from '../../email/email.service';
import { buildPain008, type Pain008Transaction } from '../../sepa/sepa-pain008';
import { BillingSaasService } from '../billing-saas.service';
import { PlatformDunningService } from '../platform-dunning.service';
import { amountToCharge, platformPricing } from '../platform-pricing';
import { SaasAddonsService } from '../saas-addons.service';

import type { Prisma } from '@storageos/database';
import type {
  CreatePlatformSepaRemittanceInput,
  PlatformSepaEligibleTenantDto,
  PlatformSepaRemittanceDto,
  PlatformSepaRemittanceItemDto,
  PlatformSepaRemittancePreviewDto,
} from '@storageos/shared';

/** AAD fijo para el IBAN del acreedor de plataforma (sin scope de tenant). */
const CREDITOR_AAD = 'platform-sepa-settings';
/**
 * Días de margen, además del preaviso pactado, para poder generar la remesa
 * antes del vencimiento (la fecha de cobro tiene que respetar el preaviso).
 */
const GRACE_DAYS_AHEAD = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  ibanLast4: string;
  ibanEncrypted: string;
  bic: string | null;
  signedAt: Date;
  sequenceType: string;
  prenoticeDays: number | null;
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
/** Días tras la fecha de cobro con la remesa sin confirmar antes de avisar. */
const STALE_AFTER_DAYS = 3;

@Injectable()
export class PlatformSepaRemittanceService {
  private readonly logger = new Logger(PlatformSepaRemittanceService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly saasAddons: SaasAddonsService,
    private readonly billingSaas: BillingSaasService,
    private readonly email: EmailService,
    private readonly dunning: PlatformDunningService,
  ) {}

  /**
   * Preaviso pactado y primera fecha de cobro posible (hora de España). Con
   * mandatos, el mayor de los que firmaron (cada tenant tiene derecho al suyo).
   */
  private async prenotice(
    mandates?: { prenoticeDays: number | null }[],
  ): Promise<{ days: number; earliest: string }> {
    const s = await this.admin.platformSepaSettings.findFirst({ select: { prenoticeDays: true } });
    const days = requiredPrenoticeDays(s?.prenoticeDays ?? 5, mandates ?? []);
    const today = todayInTimezone('Europe/Madrid');
    // La primera fecha que respeta el preaviso y es día hábil SEPA.
    const earliest = nextSepaBusinessDay(
      new Date(today.getTime() + days * DAY_MS).toISOString().slice(0, 10),
    );
    return { days, earliest };
  }

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
    withoutMandate: { tenantId: string; tenantName: string; pendingSignature?: boolean }[];
  }> {
    const { days } = await this.prenotice();
    const graceDate = new Date(Date.now() + (GRACE_DAYS_AHEAD + days) * DAY_MS);
    const subs = await this.admin.tenantSubscription.findMany({
      where: {
        billingMode: 'sepa',
        status: { in: ['active', 'past_due'] },
        currentPeriodEnd: { lte: graceDate },
        // Una cuenta exenta no paga y una anonimizada ya no es cliente: no se
        // les domicilia aunque sigan en modo SEPA.
        tenant: { deletedAt: null, billingExempt: false, status: { not: 'cancelled' } },
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
    // 36 meses sin presentar ningún adeudo: el mandato caduca.
    const today = todayInTimezone('Europe/Madrid').toISOString().slice(0, 10);
    const expired = mandates.filter((m) =>
      isSepaMandateExpired(
        m.lastCollectedAt?.toISOString().slice(0, 10) ?? null,
        m.signedAt.toISOString().slice(0, 10),
        today,
      ),
    );
    if (expired.length > 0) {
      await this.admin.platformSepaMandate.updateMany({
        where: { id: { in: expired.map((m) => m.id) }, status: 'active' },
        data: { status: 'expired' },
      });
    }
    const expiredTenants = new Set(expired.map((m) => m.tenantId));
    const mandateByTenant = new Map(
      mandates.filter((m) => !expiredTenants.has(m.tenantId)).map((m) => [m.tenantId, m]),
    );
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
    const withoutMandate: { tenantId: string; tenantName: string; pendingSignature?: boolean }[] =
      [];
    for (const sub of subs) {
      const mandate = mandateByTenant.get(sub.tenantId);
      // Solo se cobra con un mandato firmado (en la app o antes de existir la firma).
      if (!mandate || mandate.signatureStatus === 'pending') {
        withoutMandate.push({
          tenantId: sub.tenantId,
          tenantName: sub.tenant.name,
          ...(mandate ? { pendingSignature: true } : {}),
          ...(expiredTenants.has(sub.tenantId) ? { expiredMandate: true } : {}),
        });
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
    const { days, earliest } = await this.prenotice(candidates.map((c) => c.mandate));
    return {
      eligible,
      total,
      withoutMandate,
      prenoticeDays: days,
      earliestCollectionDate: earliest,
    };
  }

  async createRemittance(args: {
    /** null = preparada sola por la plataforma. */
    superAdminId: string | null;
    input: CreatePlatformSepaRemittanceInput;
  }): Promise<PlatformSepaRemittanceDto> {
    const settings = await this.admin.platformSepaSettings.findFirst();
    if (!settings?.enabled || !settings.creditorIbanEncrypted) {
      throw new BadRequestException({
        code: 'sepa_not_configured',
        message: 'Configura primero el acreedor SEPA de la plataforma',
      });
    }
    // Con los dígitos de control mal, el banco rechaza el fichero entero.
    if (!isValidCreditorId(settings.creditorId)) {
      throw new BadRequestException({
        code: 'invalid_creditor_id',
        message:
          'El identificador del acreedor no es válido (revisa los dígitos de control en SEPA de la plataforma).',
      });
    }
    assertCollectionDate(args.input.collectionDate);
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
    // El mandato pacta el preaviso: no se puede cargar antes (contrato del banco, 4.1).
    const { days, earliest } = await this.prenotice(selected.map((c) => c.mandate));
    if (args.input.collectionDate < earliest) {
      throw new BadRequestException({
        code: 'collection_date_too_soon',
        message: `La fecha de cobro tiene que respetar el preaviso de ${days} días pactado en el mandato: como pronto el ${earliest}.`,
        details: { earliestCollectionDate: earliest, prenoticeDays: days },
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
    const committed: { c: EligibleCandidate; itemId: string }[] = [];
    for (const c of selected) {
      try {
        const item = await this.admin.platformSepaRemittanceItem.create({
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
        committed.push({ c, itemId: item.id });
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
    const txs: Pain008Transaction[] = committed.map(({ c }) => ({
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
    const totalCents = committed.reduce((s, { c }) => s + toCents(c.amount), 0);
    const updated = await this.admin.platformSepaRemittance.update({
      where: { id: remittance.id },
      data: { xml, itemCount: committed.length, totalAmount: totalCents },
    });
    // Preaviso de cada cargo al tenant (importe y fecha), con constancia.
    for (const { c, itemId } of committed) {
      await this.sendPrenotice({
        itemId,
        tenantId: c.tenantId,
        amount: c.amount,
        ibanLast4: c.mandate.ibanLast4,
        mandateReference: c.mandate.reference,
        collectionDate: args.input.collectionDate,
        creditorName: settings.creditorName,
        creditorId: settings.creditorId,
      });
    }
    return this.toDto(updated, settings.updatedAt, updated.itemCount);
  }

  /** Destinatarios del preaviso: email de facturación o, si no hay, los propietarios. */
  private async prenoticeRecipients(tenantId: string): Promise<string[]> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { billingEmail: true },
    });
    if (tenant?.billingEmail) return [tenant.billingEmail];
    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    return [...new Set(owners.map((o) => o.email.toLowerCase()))];
  }

  /**
   * Envía el preaviso de un adeudo y deja constancia de lo que pasó (enviado,
   * sin destinatario o fallido): sin él, el tenant puede devolver el cargo.
   */
  private async sendPrenotice(args: {
    itemId: string;
    tenantId: string;
    amount: number;
    ibanLast4: string;
    mandateReference: string;
    collectionDate: string;
    creditorName: string;
    creditorId: string;
  }): Promise<'sent' | 'no_email' | 'failed'> {
    const record = (status: 'sent' | 'no_email' | 'failed', to: string[] = []) =>
      this.admin.platformSepaRemittanceItem.update({
        where: { id: args.itemId },
        data: {
          prenoticeStatus: status,
          ...(status === 'sent'
            ? { prenoticeSentAt: new Date(), prenoticeRecipients: to.join(', ') }
            : {}),
        },
      });
    try {
      const to = await this.prenoticeRecipients(args.tenantId);
      if (to.length === 0) {
        await record('no_email');
        return 'no_email';
      }
      const amount = formatEur(args.amount);
      const date = formatDateLong(new Date(`${args.collectionDate}T12:00:00Z`));
      const lines = [
        `Te avisamos de que el ${date} cargaremos ${amount} en tu cuenta terminada en ${args.ibanLast4} por tu suscripción a TrasterOS.`,
        `Acreedor: ${args.creditorName} (${args.creditorId}). Referencia del mandato: ${args.mandateReference}.`,
        'Si algo no es correcto, responde a este correo antes de esa fecha.',
      ];
      const subject = `Preaviso de cargo: ${amount} el ${date}`;
      let sent = 0;
      for (const email of to) {
        const res = await this.email.sendRendered({
          to: email,
          kind: 'sepa_prenotice',
          subject,
          html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
          text: lines.join('\n\n'),
        });
        if (!res.suppressed) sent++;
      }
      const status = sent > 0 ? 'sent' : 'failed';
      await record(status, to);
      return status;
    } catch (err) {
      this.logger.warn(
        `[platform-sepa] preaviso a ${args.tenantId} falló: ${err instanceof Error ? err.message : err}`,
      );
      await record('failed').catch(() => undefined);
      return 'failed';
    }
  }

  /**
   * Vuelve a enviar los preavisos que no salieron (sin destinatario o con
   * error) de una remesa aún sin confirmar. Si la fecha de cobro ya no respeta
   * el preaviso, hay que cancelar la remesa y generar otra.
   */
  async retryPrenotices(id: string): Promise<{ sent: number; failed: number; noEmail: number }> {
    const remittance = await this.findOrThrow(id);
    if (remittance.status !== 'generated') {
      throw new BadRequestException({
        code: 'remittance_not_generated',
        message: 'Solo se pueden reenviar los preavisos de una remesa sin confirmar',
      });
    }
    const settings = await this.admin.platformSepaSettings.findFirst();
    const items = await this.admin.platformSepaRemittanceItem.findMany({
      where: {
        remittanceId: id,
        itemStatus: 'pending',
        OR: [{ prenoticeStatus: null }, { prenoticeStatus: { not: 'sent' } }],
      },
      include: { mandate: { select: { ibanLast4: true, reference: true } } },
    });
    const out = { sent: 0, failed: 0, noEmail: 0 };
    for (const item of items) {
      const status = await this.sendPrenotice({
        itemId: item.id,
        tenantId: item.tenantId,
        amount: item.amount / 100,
        ibanLast4: item.mandate.ibanLast4,
        mandateReference: item.mandate.reference,
        collectionDate: remittance.collectionDate.toISOString().slice(0, 10),
        creditorName: settings?.creditorName ?? '',
        creditorId: settings?.creditorId ?? '',
      });
      if (status === 'sent') out.sent++;
      else if (status === 'no_email') out.noEmail++;
      else out.failed++;
    }
    return out;
  }

  async listRemittances(): Promise<PlatformSepaRemittanceDto[]> {
    const [rows, settings, counts] = await Promise.all([
      this.admin.platformSepaRemittance.findMany({ orderBy: { createdAt: 'desc' } }),
      this.admin.platformSepaSettings.findFirst(),
      this.admin.platformSepaRemittanceItem.groupBy({
        by: ['remittanceId', 'itemStatus'],
        _count: { _all: true },
      }),
    ]);
    const countOf = (id: string, status: string) =>
      counts.find((c) => c.remittanceId === id && c.itemStatus === status)?._count._all ?? 0;
    return rows.map((r) =>
      this.toDto(r, settings?.updatedAt, countOf(r.id, 'pending'), {
        collected: countOf(r.id, 'collected'),
        bounced: countOf(r.id, 'bounced'),
      }),
    );
  }

  /**
   * Prepara la remesa sola (si el super admin lo activó): con la primera fecha
   * de cobro que respeta el preaviso, envía los preavisos a los tenants y deja
   * la remesa sin confirmar para que el super admin la suba al banco. También
   * avisa una vez de las remesas que llevan días sin confirmar.
   */
  async autoPrepare(now = new Date()): Promise<{ prepared: string | null; stale: number }> {
    const settings = await this.admin.platformSepaSettings.findFirst();
    let prepared: string | null = null;
    if (settings?.enabled && settings.autoPrepare && settings.creditorIbanEncrypted) {
      const { candidates } = await this.eligible();
      if (candidates.length > 0) {
        const { earliest } = await this.prenotice(candidates.map((c) => c.mandate));
        try {
          const r = await this.createRemittance({
            superAdminId: null,
            input: {
              name: `Remesa automática ${formatDateLong(new Date(`${earliest}T12:00:00Z`))}`,
              collectionDate: earliest,
            },
          });
          prepared = r.id;
          await this.admin.superAdminNotification.create({
            data: {
              type: 'platform_sepa.remittance_prepared',
              title: `Remesa SEPA preparada: ${r.itemCount} adeudos (${r.total.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })})`,
              body: `Cobro el ${earliest}. Descarga el fichero, súbelo al banco y confírmala cuando se cobre. Los tenants ya tienen el preaviso.`,
              link: `/admin/platform-sepa/remittances?id=${r.id}`,
            },
          });
        } catch (err) {
          this.logger.warn(
            `[platform-sepa] no se pudo preparar la remesa automática: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    // Remesas generadas hace días sin confirmar: el cobro puede no haberse presentado.
    const stale = await this.admin.platformSepaRemittance.findMany({
      where: {
        status: 'generated',
        staleNotifiedAt: null,
        collectionDate: { lt: toDateOnly(new Date(now.getTime() - STALE_AFTER_DAYS * DAY_MS)) },
      },
    });
    for (const r of stale) {
      const { count } = await this.admin.platformSepaRemittance.updateMany({
        where: { id: r.id, staleNotifiedAt: null },
        data: { staleNotifiedAt: now },
      });
      if (count === 0) continue;
      await this.admin.superAdminNotification.create({
        data: {
          type: 'platform_sepa.remittance_unconfirmed',
          title: `La remesa «${r.name}» sigue sin confirmar`,
          body: `Su fecha de cobro era el ${r.collectionDate.toISOString().slice(0, 10)}. Si el banco la cobró, confírmala; si no se presentó, cancélala para volver a domiciliar esas cuotas.`,
          link: `/admin/platform-sepa/remittances?id=${r.id}`,
        },
      });
    }
    return { prepared, stale: stale.length };
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
    const count = (st: string) => items.filter((i) => i.itemStatus === st).length;
    return {
      ...this.toDto(r, settings?.updatedAt, count('pending'), {
        collected: count('collected'),
        bounced: count('bounced'),
      }),
      items: items.map((i) => ({
        id: i.id,
        tenantId: i.tenantId,
        tenantName: i.tenant.name,
        amount: i.amount / 100,
        periodCovered: i.periodCovered.toISOString().slice(0, 10),
        itemStatus: i.itemStatus as PlatformSepaRemittanceItemDto['itemStatus'],
        bouncedAt: i.bouncedAt?.toISOString() ?? null,
        bounceReason: i.bounceReason,
        prenoticeStatus: i.prenoticeStatus as 'sent' | 'failed' | 'no_email' | null,
        prenoticeSentAt: i.prenoticeSentAt?.toISOString() ?? null,
        prenoticeRecipients: i.prenoticeRecipients,
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
    const collectedMandates = new Set<string>();
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
        collectedMandates.add(item.mandateId);
      } catch (err) {
        this.logger.warn(
          `[platform-sepa] confirmar item ${item.id} (tenant ${item.tenantId}) falló: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // El primer cobro con éxito de un mandato pasa de FRST a RCUR (solo los
    // cobrados: un adeudo que no se pudo registrar no cuenta como usado).
    const mandateIds = [...collectedMandates];
    await this.admin.platformSepaMandate.updateMany({
      where: { id: { in: mandateIds }, sequenceType: 'FRST', status: 'active' },
      data: { sequenceType: 'RCUR' },
    });
    // Último adeudo presentado: cuenta para la caducidad de 36 meses.
    await this.admin.platformSepaMandate.updateMany({
      where: { id: { in: mandateIds } },
      data: { lastCollectedAt: remittance.collectionDate },
    });
    const updated = await this.findOrThrow(id);
    return this.toDto(updated, undefined, await this.pendingCount(id));
  }

  /**
   * Cancela una remesa sin confirmar (no se envió al banco, el banco la rechazó
   * entera o algún preaviso no llegó a tiempo): sus adeudos se pueden volver a
   * domiciliar en otra remesa con otra fecha.
   */
  async cancelRemittance(id: string): Promise<PlatformSepaRemittanceDto> {
    await this.findOrThrow(id);
    await this.admin.$transaction(async (tx) => {
      const { count } = await tx.platformSepaRemittance.updateMany({
        where: { id, status: 'generated' },
        data: { status: 'cancelled' },
      });
      if (count === 0) {
        throw new BadRequestException({
          code: 'remittance_not_cancellable',
          message: 'Solo se puede cancelar una remesa sin confirmar',
        });
      }
      await tx.platformSepaRemittanceItem.updateMany({
        where: { remittanceId: id, itemStatus: 'pending' },
        data: { itemStatus: 'cancelled' },
      });
    });
    return this.toDto(await this.findOrThrow(id), undefined, 0);
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
    // Se avisa al tenant de que su banco devolvió el adeudo y de cómo pagar.
    await this.dunning.remindNow(item.tenantId).catch(() => undefined);
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
    counts: { collected: number; bounced: number } = { collected: 0, bounced: 0 },
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
      collectedCount: counts.collected,
      bouncedCount: counts.bounced,
      automatic: r.createdBySuperAdminId === null,
    };
  }
}

/** Los datos del acreedor y del mandato los escribe el super admin. */
function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
