import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OPPORTUNITY_LABELS,
  type DismissOpportunityInput,
  type OpportunitiesDto,
  type OpportunityDismissalDto,
  type ProposeBulkInput,
  type ProposeBulkResultDto,
  type OpportunityDraftDto,
  type OpportunityDto,
  type OpportunityKind,
  OpportunityKindEnum,
  type PortalInterestInput,
  type ProposeOpportunityInput,
  type ProposeOpportunityResultDto,
} from '@storageos/shared';

import { customerScopeWhere } from '../../common/customer-scope';
import { type FacilityScope } from '../../common/facility-scope';
import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { CHARGEABLE_MANDATE_WHERE } from '../../common/sepa-remittance-guard';
import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const gross = (net: number, tax = 21) => round2(net * (1 + tax / 100));

type NameRow = {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  customerType: string;
};
const nameOf = (c: NameRow) =>
  c.customerType === 'business'
    ? (c.companyName ?? '—')
    : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
const firstNameOf = (c: NameRow) =>
  c.customerType === 'business' ? (c.companyName ?? '') : (c.firstName ?? '');

/** Lo que se guarda con la propuesta para saber después si lo contrató. */
type Computed = OpportunityDto & { offerMetadata: Record<string, unknown> };

/** Una misma propuesta no se repite antes de este tiempo (doble clic, dos personas). */
const REPROPOSE_GUARD_MS = 10 * 60_000;

/**
 * Oportunidades sobre los inquilinos: qué ofrecer a quién y por qué, a partir
 * de lo que tienen contratado y de lo que miran en su área de clientes. El
 * sistema solo sugiere y redacta la propuesta: no cambia nada del contrato.
 */

import { CustomerOffersService } from './customer-offers.service';

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
    private readonly config: ConfigService,
    private readonly offers: CustomerOffersService,
    private readonly paymentMethods: PaymentMethodsService,
  ) {}

  /**
   * ¿Puede el inquilino dejar el cobro automático? Tarjeta (Stripe o Redsys con
   * pago por referencia), GoCardless o remesas SEPA. Sin ninguno, proponer
   * «domiciliar» le pide algo que no puede hacer.
   */
  private async canAutopay(tenantId: string): Promise<boolean> {
    if (await this.paymentMethods.cardPaymentsAvailable(tenantId)) return true;
    const [redsys, gocardless, sepa] = await Promise.all([
      this.admin.redsysSettings.findFirst({
        where: { tenantId, enabled: true, cardOnFileEnabled: true },
        select: { id: true },
      }),
      this.admin.goCardlessSettings.findFirst({
        where: { tenantId, enabled: true },
        select: { id: true },
      }),
      this.admin.sepaSettings.findFirst({
        where: { tenantId, enabled: true },
        select: { id: true },
      }),
    ]);
    return !!(redsys || gocardless || sepa);
  }

  /** Lo registra el área de clientes (una vez por hora y tipo). */
  async recordInterest(tenantId: string, customerId: string, input: PortalInterestInput) {
    await this.prisma.withTenant(async (tx) => {
      const recent = await tx.customerInterestEvent.findFirst({
        where: {
          customerId,
          kind: input.kind,
          createdAt: { gte: new Date(Date.now() - 3_600_000) },
        },
        select: { id: true },
      });
      if (recent) return;
      if (input.unitTypeId) {
        const ok = await tx.unitType.findFirst({
          where: { id: input.unitTypeId },
          select: { id: true },
        });
        if (!ok) return;
      }
      await tx.customerInterestEvent.create({
        data: {
          tenantId,
          customerId,
          kind: input.kind,
          unitTypeId: input.unitTypeId ?? null,
        },
      });
    }, tenantId);
  }

  async list(tenantId: string, scope: FacilityScope, now = new Date()): Promise<OpportunitiesDto> {
    const items = (await this.compute(tenantId, scope, now)).map(
      ({ offerMetadata: _meta, ...o }) => o,
    );
    const byKind = Object.fromEntries(
      OpportunityKindEnum.options.map((k) => {
        const of = items.filter((i) => i.kind === k);
        return [
          k,
          { count: of.length, monthlyValue: round2(of.reduce((s, i) => s + i.monthlyValue, 0)) },
        ];
      }),
    ) as OpportunitiesDto['byKind'];
    return { items, byKind };
  }

  /** La oportunidad de un inquilino (calcula solo la suya). */
  private async findOne(
    tenantId: string,
    customerId: string,
    kind: OpportunityKind,
    scope: FacilityScope,
  ): Promise<Computed> {
    const opp = (await this.compute(tenantId, scope, new Date(), customerId)).find(
      (i) => i.kind === kind,
    );
    if (!opp) {
      throw new NotFoundException({
        code: 'opportunity_not_found',
        message: 'Esta oportunidad ya no aplica a este inquilino.',
      });
    }
    return opp;
  }

  private async compute(
    tenantId: string,
    scope: FacilityScope,
    now: Date,
    onlyCustomerId?: string,
  ): Promise<Computed[]> {
    const [hasInsurance, autopayAvailable] = await Promise.all([
      tenantHasFeature(this.admin, tenantId, 'insurance'),
      this.canAutopay(tenantId),
    ]);
    const items = await this.prisma.withTenant(async (tx) => {
      const [
        tenant,
        contracts,
        plans,
        interests,
        denied,
        methods,
        mandates,
        changeRequests,
        proposed,
        overdue,
      ] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            nightPassEnabled: true,
            nightPassPrice: true,
            googleReviewUrl: true,
            referralEnabled: true,
            referralRewardType: true,
            referralRewardValue: true,
            timezone: true,
          },
        }),
        tx.contract.findMany({
          where: {
            deletedAt: null,
            // Las bajas pedidas, solo para ofrecer un trastero más pequeño.
            status: { in: ['active', 'ending'] },
            ...(onlyCustomerId ? { customerId: onlyCustomerId } : {}),
            // Las propuestas son comunicaciones comerciales: no a quien se dio de
            // baja. El inquilino de prueba de la puesta en marcha tampoco.
            customer: { marketingOptOutAt: null, deletedAt: null, isTest: false },
            ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
          },
          select: {
            id: true,
            customerId: true,
            status: true,
            signedAt: true,
            endDate: true,
            autoRenew: true,
            billingIntervalMonths: true,
            insurancePlanId: true,
            unit: { select: { code: true, facilityId: true, areaM2: true } },
            priceMonthly: true,
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
                email: true,
                phone: true,
                documentNumber: true,
                address: true,
              },
            },
          },
        }),
        tx.insurancePlan.findMany({
          where: { isActive: true },
          select: { name: true, monthlyPrice: true, taxRate: true },
          orderBy: { monthlyPrice: 'asc' },
          take: 1,
        }),
        tx.customerInterestEvent.groupBy({
          by: ['customerId', 'kind'],
          where: {
            createdAt: { gte: new Date(now.getTime() - 60 * DAY) },
            ...(onlyCustomerId ? { customerId: onlyCustomerId } : {}),
          },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        tx.accessLog.groupBy({
          by: ['customerId'],
          where: {
            result: 'denied_outside_hours',
            customerId: { not: null },
            occurredAt: { gte: new Date(now.getTime() - 60 * DAY) },
          },
          _count: { _all: true },
        }),
        tx.paymentMethod.findMany({
          where: { deletedAt: null, type: { in: ['card', 'sepa_debit'] } },
          select: { customerId: true },
        }),
        tx.sepaMandate.findMany({
          where: CHARGEABLE_MANDATE_WHERE,
          select: { customerId: true },
        }),
        tx.unitChangeRequest.findMany({
          where: { status: 'pending', ...(onlyCustomerId ? { customerId: onlyCustomerId } : {}) },
          select: { customerId: true, contractId: true, targetUnitId: true },
        }),
        tx.communication.groupBy({
          by: ['customerId', 'source'],
          where: {
            customerId: onlyCustomerId ?? { not: null },
            source: { startsWith: 'opportunity:' },
          },
          _max: { createdAt: true },
        }),
        // Facturas vencidas ahora o pagadas tarde en 90 días (antes contaba
        // cualquier factura pagada, también las pagadas a tiempo).
        tx.invoice.findMany({
          where: {
            customerId: onlyCustomerId ?? { not: null },
            deletedAt: null,
            kind: 'invoice',
            dueDate: { gte: new Date(now.getTime() - 90 * DAY) },
            OR: [{ status: 'overdue' }, { status: 'paid', paidAt: { not: null } }],
          },
          select: { customerId: true, status: true, dueDate: true, paidAt: true },
        }),
      ]);

      const [promoterRows, referrerRows, dismissalRows] = await Promise.all([
        tx.review.findMany({
          where: {
            status: 'submitted',
            npsScore: { gte: 9 },
            googleRequestedAt: null,
            submittedAt: { gte: new Date(now.getTime() - 365 * DAY) },
            ...(onlyCustomerId ? { customerId: onlyCustomerId } : {}),
          },
          select: { customerId: true },
        }),
        tx.referral.findMany({
          where: onlyCustomerId ? { referrerCustomerId: onlyCustomerId } : {},
          select: { referrerCustomerId: true },
          distinct: ['referrerCustomerId'],
        }),
        onlyCustomerId
          ? Promise.resolve([])
          : tx.opportunityDismissal.findMany({
              where: { OR: [{ until: null }, { until: { gt: now } }] },
              select: { customerId: true, kind: true },
            }),
      ]);
      const promoters = new Set(promoterRows.map((r) => r.customerId));
      const referrers = new Set(referrerRows.map((r) => r.referrerCustomerId));
      const dismissed = new Set(dismissalRows.map((d) => `${d.customerId}:${d.kind}`));

      // Trasteros libres por local, para proponer otro o uno mayor.
      const facilityIds = [...new Set(contracts.map((c) => c.unit.facilityId))];
      const available = facilityIds.length
        ? await tx.unit.findMany({
            where: { facilityId: { in: facilityIds }, status: 'available' },
            select: {
              facilityId: true,
              code: true,
              areaM2: true,
              basePriceMonthly: true,
              unitType: { select: { name: true, propertyKind: true } },
              facility: { select: { name: true } },
            },
            orderBy: { basePriceMonthly: 'asc' },
          })
        : [];

      const interestBy = new Map<string, { count: number; last: Date | null }>();
      for (const i of interests) {
        interestBy.set(`${i.customerId}:${i.kind}`, {
          count: i._count._all,
          last: i._max.createdAt,
        });
      }
      const deniedBy = new Map(denied.map((d) => [d.customerId!, d._count._all]));
      const chargeable = new Set(methods.map((m) => m.customerId));
      const mandate = new Set(mandates.map((m) => m.customerId));
      const changeBy = new Map(changeRequests.map((r) => [r.customerId, r]));
      const offerStatus = await this.offers.lastStatusByCustomerKind(tenantId, onlyCustomerId);
      // Última propuesta: por correo o registrada (WhatsApp) en el área de clientes.
      const proposedBy = new Map<string, Date>();
      const mark = (key: string, at: Date) => {
        const prev = proposedBy.get(key);
        if (!prev || at > prev) proposedBy.set(key, at);
      };
      for (const p of proposed) {
        if (p.customerId && p._max.createdAt) {
          mark(`${p.customerId}:${p.source!.slice('opportunity:'.length)}`, p._max.createdAt);
        }
      }
      for (const [key, o] of offerStatus) mark(key, o.createdAt);
      const DAY_GRACE = DAY;
      const hadOverdue = new Set(
        overdue
          .filter(
            (i) =>
              i.status === 'overdue' ||
              (i.paidAt && i.dueDate && i.paidAt.getTime() > i.dueDate.getTime() + DAY_GRACE),
          )
          .map((i) => i.customerId!),
      );

      type Row = (typeof contracts)[number];
      const byCustomer = new Map<string, Row[]>();
      for (const c of contracts)
        byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);

      const out: Computed[] = [];
      const push = (
        rows: Row[],
        kind: OpportunityKind,
        o: Pick<
          OpportunityDto,
          'reason' | 'offer' | 'priceMonthlyGross' | 'monthlyValue' | 'score'
        > & { offerMetadata?: Record<string, unknown> },
      ) => {
        const c = rows[0]!;
        if (dismissed.has(`${c.customerId}:${kind}`)) return;
        const last = proposedBy.get(`${c.customerId}:${kind}`) ?? null;
        out.push({
          id: `${c.customerId}:${kind}`,
          kind,
          customerId: c.customerId,
          customerName: nameOf(c.customer),
          email: c.customer.email,
          phone: c.customer.phone,
          units: rows.map((r) => r.unit.code),
          facilityIds: [...new Set(rows.map((r) => r.unit.facilityId))],
          ...o,
          // Lo propuesto hace poco baja: no insistir.
          score:
            last && now.getTime() - last.getTime() < 30 * DAY ? Math.round(o.score / 3) : o.score,
          lastProposedAt: last?.toISOString() ?? null,
          lastOfferStatus: offerStatus.get(`${c.customerId}:${kind}`)?.status ?? null,
          offerMetadata: o.offerMetadata ?? {},
        });
      };

      const plan = plans[0];
      const nightPrice = Number(tenant?.nightPassPrice ?? 0);
      const reward =
        tenant && Number(tenant.referralRewardValue) > 0
          ? tenant.referralRewardType === 'percentage'
            ? `un ${Number(tenant.referralRewardValue)} % de descuento`
            : `${formatEur(Number(tenant.referralRewardValue))} de descuento`
          : null;
      for (const [customerId, allRows] of byCustomer) {
        const interest = (k: string) => interestBy.get(`${customerId}:${k}`);
        const rows = allRows.filter((r) => r.status === 'active');
        const ending = allRows.filter((r) => r.status === 'ending');

        // Baja pedida: un trastero más pequeño y más barato del mismo local.
        for (const current of ending) {
          const area = Number(current.unit.areaM2 ?? 0);
          const smaller = available
            .filter(
              (u) =>
                u.facilityId === current.unit.facilityId &&
                Number(u.areaM2 ?? 0) > 0 &&
                Number(u.areaM2 ?? 0) < area &&
                Number(u.basePriceMonthly) < Number(current.priceMonthly) &&
                u.unitType.propertyKind !== 'housing',
            )
            .sort((a, b) => Number(b.areaM2 ?? 0) - Number(a.areaM2 ?? 0))[0];
          if (!smaller) continue;
          push([current], 'smaller_unit', {
            reason: `Ha pedido la baja de ${current.unit.code}${
              current.endDate ? ` (se va el ${formatDateLong(current.endDate)})` : ''
            }.`,
            offer: `${smaller.unitType.name} (${Number(smaller.areaM2 ?? 0)} m²) en ${smaller.facility.name} por ${formatEur(gross(Number(smaller.basePriceMonthly)))}/mes (IVA incl.)`,
            priceMonthlyGross: gross(Number(smaller.basePriceMonthly)),
            monthlyValue: Number(smaller.basePriceMonthly),
            score: 65,
            offerMetadata: { contractId: current.id },
          });
          break;
        }
        if (!rows.length) continue;
        const customer = rows[0]!.customer;
        const signedLongAgo = (days: number) =>
          rows.some((r) => r.signedAt && now.getTime() - r.signedAt.getTime() > days * DAY);
        const lastProposed = (k: OpportunityKind) => proposedBy.get(`${customerId}:${k}`) ?? null;

        // Renovar: contratos que terminan en 60 días sin renovación automática.
        for (const r of rows) {
          if (r.autoRenew || !r.endDate) continue;
          const left = (r.endDate.getTime() - now.getTime()) / DAY;
          if (left < 0 || left > 60) continue;
          push([r], 'renewal', {
            reason: `Su contrato de ${r.unit.code} termina el ${formatDateLong(r.endDate)} y no se renueva solo.`,
            offer: `Renovar el contrato (termina el ${formatDateLong(r.endDate)})`,
            priceMonthlyGross: gross(Number(r.priceMonthly)),
            monthlyValue: Number(r.priceMonthly),
            score: 55 + (left < 30 ? 15 : 0),
            offerMetadata: { contractId: r.id, endDate: r.endDate.toISOString() },
          });
          break;
        }

        // Pagar el año por adelantado: clientes de más de 6 meses que pagan al día.
        const monthly = rows.filter((r) => r.billingIntervalMonths === 1);
        if (monthly.length && signedLongAgo(180) && !hadOverdue.has(customerId)) {
          const value = monthly.reduce((sum, r) => sum + Number(r.priceMonthly), 0);
          push(monthly, 'annual_prepay', {
            reason: 'Lleva más de 6 meses y paga al día cada mes.',
            offer: 'Pagar los próximos 12 meses de una vez',
            priceMonthlyGross: gross(value),
            // Adelanta caja, no suma cuota.
            monthlyValue: 0,
            score: 25,
            offerMetadata: { contractIds: monthly.map((r) => r.id) },
          });
        }

        // Completar sus datos: sin teléfono, documento o dirección (facturas, contrato).
        const missing = [
          !customer.phone ? 'teléfono' : null,
          !customer.documentNumber ? 'DNI o NIE' : null,
          !customer.address ? 'dirección' : null,
        ].filter((x): x is string => !!x);
        if (missing.length) {
          push(rows, 'incomplete_data', {
            reason: `Le falta${missing.length > 1 ? 'n' : ''} ${missing.join(', ')}.`,
            offer: missing.join(', '),
            priceMonthlyGross: null,
            monthlyValue: 0,
            score: 15 + missing.length * 5,
          });
        }

        // Reseña en Google: puntuó 9 o 10 y no se le ha pedido (una sola vez).
        if (
          tenant?.googleReviewUrl &&
          promoters.has(customerId) &&
          !lastProposed('google_review')
        ) {
          push(rows, 'google_review', {
            reason: 'Nos puso un 9 o un 10 en la encuesta de satisfacción.',
            offer: 'Dejar una reseña en Google',
            priceMonthlyGross: null,
            monthlyValue: 0,
            score: 30,
            offerMetadata: { url: tenant.googleReviewUrl },
          });
        }

        // Recomendar: contento, más de 3 meses, al día y aún no ha traído a nadie.
        const lastReferral = lastProposed('referral');
        if (
          tenant?.referralEnabled &&
          reward &&
          signedLongAgo(90) &&
          !hadOverdue.has(customerId) &&
          !referrers.has(customerId) &&
          (!lastReferral || now.getTime() - lastReferral.getTime() > 180 * DAY)
        ) {
          push(rows, 'referral', {
            reason: promoters.has(customerId)
              ? 'Está contento (nos puso un 9 o un 10) y aún no ha recomendado a nadie.'
              : 'Lleva más de 3 meses, paga al día y aún no ha recomendado a nadie.',
            offer: `Recomendar con su código: ${reward} por cada amigo`,
            priceMonthlyGross: null,
            monthlyValue: 0,
            score: 20 + (promoters.has(customerId) ? 15 : 0),
          });
        }

        // Seguro: contratos sin protección.
        const uninsured = rows.filter((r) => !r.insurancePlanId);
        if (hasInsurance && plan && uninsured.length) {
          const seen = interest('insurance');
          const price = Number(plan.monthlyPrice);
          push(uninsured, 'insurance', {
            reason: seen
              ? `Miró el seguro en su área de clientes (${seen.count} ${seen.count === 1 ? 'vez' : 'veces'}) y no lo contrató.`
              : `${uninsured.length === 1 ? 'Su trastero no tiene' : `${uninsured.length} trasteros sin`} protección de contenido.`,
            offer: `${plan.name} por ${formatEur(gross(price, Number(plan.taxRate)))}/mes (IVA incl.)`,
            priceMonthlyGross: gross(price, Number(plan.taxRate)),
            monthlyValue: round2(price * uninsured.length),
            score: 30 + (seen ? 40 : 0),
            offerMetadata: { contractIds: uninsured.map((r) => r.id) },
          });
        }

        // Trastero mayor: lo ha mirado o ha pedido cambiar. Si ya pidió uno
        // concreto, el cambio está en marcha y no se propone otro.
        const larger = interest('larger_unit');
        const change = changeBy.get(customerId);
        if ((larger || change) && !change?.targetUnitId) {
          // El contrato del que pidió cambiar o, si no, el trastero más pequeño.
          const current =
            rows.find((r) => r.id === change?.contractId) ??
            [...rows].sort((a, b) => Number(a.unit.areaM2 ?? 0) - Number(b.unit.areaM2 ?? 0))[0]!;
          const area = Number(current.unit.areaM2 ?? 0);
          // El más pequeño de los mayores (y, a igual tamaño, el más barato).
          const next = available
            .filter(
              (u) =>
                u.facilityId === current.unit.facilityId &&
                Number(u.areaM2 ?? 0) > area &&
                u.unitType.propertyKind !== 'housing',
            )
            .sort(
              (a, b) =>
                Number(a.areaM2 ?? 0) - Number(b.areaM2 ?? 0) ||
                Number(a.basePriceMonthly) - Number(b.basePriceMonthly),
            )[0];
          if (next) {
            const diff = round2(Number(next.basePriceMonthly) - Number(current.priceMonthly));
            push([current], 'larger_unit', {
              reason: change
                ? 'Ha pedido cambiar de trastero.'
                : 'Miró trasteros más grandes en su área de clientes.',
              offer: `${next.unitType.name} (${Number(next.areaM2 ?? 0)} m²) en ${next.facility.name} por ${formatEur(gross(Number(next.basePriceMonthly)))}/mes (IVA incl.)`,
              priceMonthlyGross: gross(Number(next.basePriceMonthly)),
              monthlyValue: Math.max(0, diff),
              score: 60,
              offerMetadata: { contractId: current.id },
            });
          }
        }

        // Otro trastero: lo miró en los últimos 30 días.
        const extra = interest('additional_unit');
        if (extra?.last && now.getTime() - extra.last.getTime() < 30 * DAY) {
          const cheapest = available.find(
            (u) =>
              rows.some((r) => r.unit.facilityId === u.facilityId) &&
              u.unitType.propertyKind !== 'housing',
          );
          if (cheapest) {
            push(rows, 'additional_unit', {
              reason: `Miró «Contratar otro trastero» (${extra.count} ${extra.count === 1 ? 'vez' : 'veces'}) sin contratar.`,
              offer: `Otro trastero en ${cheapest.facility.name} desde ${formatEur(gross(Number(cheapest.basePriceMonthly)))}/mes (IVA incl.)`,
              priceMonthlyGross: gross(Number(cheapest.basePriceMonthly)),
              monthlyValue: Number(cheapest.basePriceMonthly),
              score: 50,
            });
          }
        }

        // Pase nocturno: intentó entrar fuera de horario.
        const deniedCount = deniedBy.get(customerId) ?? 0;
        const nightSeen = interest('night_pass');
        if (tenant?.nightPassEnabled && (deniedCount > 0 || nightSeen)) {
          push(rows, 'night_pass', {
            reason:
              deniedCount > 0
                ? `Intentó entrar fuera de horario ${deniedCount} ${deniedCount === 1 ? 'vez' : 'veces'} en 60 días.`
                : 'Miró el pase nocturno en su área de clientes.',
            offer: `Pase nocturno por ${formatEur(gross(nightPrice))} (IVA incl.)`,
            priceMonthlyGross: gross(nightPrice),
            // Es un pago suelto, no una cuota: no suma al potencial mensual.
            monthlyValue: 0,
            score: 35 + Math.min(30, deniedCount * 10),
          });
        }

        // Domiciliar: paga a mano.
        if (autopayAvailable && !chargeable.has(customerId) && !mandate.has(customerId)) {
          push(rows, 'autopay', {
            reason: hadOverdue.has(customerId)
              ? 'Paga a mano y ha tenido facturas vencidas en los últimos 90 días.'
              : 'Paga a mano: sin tarjeta ni domiciliación guardadas.',
            offer:
              'Guardar su tarjeta o IBAN en el área de clientes para que el cobro sea automático',
            priceMonthlyGross: null,
            monthlyValue: 0,
            score: 20 + (hadOverdue.has(customerId) ? 30 : 0),
          });
        }
      }
      return out;
    }, tenantId);

    // Primero quien ha dicho «me interesa»: es una venta casi hecha.
    const interested = (o: Computed) => (o.lastOfferStatus === 'interested' ? 1 : 0);
    items.sort(
      (a, b) =>
        interested(b) - interested(a) || b.score - a.score || b.monthlyValue - a.monthlyValue,
    );
    return items;
  }

  async draft(
    tenantId: string,
    customerId: string,
    kind: OpportunityKind,
    scope: FacilityScope,
  ): Promise<OpportunityDraftDto> {
    return this.buildDraft(tenantId, await this.findOne(tenantId, customerId, kind, scope));
  }

  private async buildDraft(tenantId: string, opp: Computed): Promise<OpportunityDraftDto> {
    const kind = opp.kind;
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    const reviewUrl = typeof opp.offerMetadata.url === 'string' ? opp.offerMetadata.url : null;
    const customer = await this.admin.customer.findUniqueOrThrow({
      where: { id: opp.customerId },
      select: { firstName: true, lastName: true, companyName: true, customerType: true },
    });
    const portalUrl = tenantPortalLoginUrl(
      this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3000',
      tenant,
    );
    const hello = `Hola${firstNameOf(customer) ? ` ${firstNameOf(customer)}` : ''}:`;
    const pitch: Record<OpportunityKind, { subject: string; line: string }> = {
      insurance: {
        subject: 'Protege lo que guardas en tu trastero',
        line: `Puedes añadir la protección de contenido a tu trastero: ${opp.offer}.`,
      },
      larger_unit: {
        subject: 'Tenemos un trastero más grande para ti',
        line: `Tenemos libre ${opp.offer}. Si te interesa, te lo reservamos y nos encargamos del cambio.`,
      },
      additional_unit: {
        subject: '¿Necesitas otro trastero?',
        line: `Vimos que mirabas otro trastero. Tenemos ${opp.offer.charAt(0).toLowerCase()}${opp.offer.slice(1)}.`,
      },
      night_pass: {
        subject: 'Acceso fuera de horario',
        line: `Si necesitas entrar fuera del horario del local, puedes comprar un ${opp.offer.charAt(0).toLowerCase()}${opp.offer.slice(1)} desde tu área de clientes.`,
      },
      autopay: {
        subject: 'Paga tu trastero sin preocuparte',
        line: 'Si guardas tu tarjeta o tu IBAN en tu área de clientes, cobraremos cada mes de forma automática y no tendrás que estar pendiente de los plazos.',
      },
      annual_prepay: {
        subject: 'Paga tu trastero de una vez y olvídate',
        line: 'Si lo prefieres, puedes pagar los próximos 12 meses de una vez y olvidarte de los recibos de cada mes. Respóndenos y te lo preparamos.',
      },
      renewal: {
        subject: 'Tu contrato está a punto de terminar',
        line: `${opp.offer.replace(/^Renovar el contrato \(termina el (.+)\)$/, 'Tu contrato termina el $1')}. Si quieres seguir con nosotros, respóndenos y lo renovamos sin papeleo.`,
      },
      incomplete_data: {
        subject: 'Nos faltan algunos datos tuyos',
        line: `Para tus facturas y tu contrato nos falta: ${opp.offer}. Puedes completarlo en un minuto en tu área de clientes (Mis datos).`,
      },
      google_review: {
        subject: '¿Nos ayudas con una reseña?',
        line: `Nos alegra mucho que estés contento con nosotros. ¿Nos dejas una reseña en Google? Solo te llevará un minuto${reviewUrl ? `: ${reviewUrl}` : '.'}`,
      },
      referral: {
        subject: 'Recomienda y gana',
        line: `${opp.offer.replace(/^Recomendar con su código: /, 'Si un amigo alquila un trastero con tu código, te llevas ')}. Encontrarás tu código en tu área de clientes.`,
      },
      smaller_unit: {
        subject: '¿Y si te quedas con uno más pequeño?',
        line: `Hemos visto que vas a dejar tu trastero. Si lo que necesitas es menos espacio, tenemos ${opp.offer.charAt(0).toLowerCase()}${opp.offer.slice(1)}. Respóndenos y te lo cambiamos.`,
      },
    };
    const p = pitch[kind];
    return {
      subject: p.subject,
      body: `${hello}\n\n${p.line}\n\nPuedes verlo en tu área de clientes: ${portalUrl}\n\nCualquier duda, responde a este correo.\n\n${tenant.name}`,
      whatsappText: `${hello} ${p.line} ${portalUrl}`,
      portalUrl,
      offerText: p.line,
    };
  }

  async propose(
    tenantId: string,
    userId: string,
    input: ProposeOpportunityInput,
    scope: FacilityScope,
  ): Promise<ProposeOpportunityResultDto> {
    const opp = await this.findOne(tenantId, input.customerId, input.kind, scope);
    const draft = await this.buildDraft(tenantId, opp);
    const customer = await this.admin.customer.findFirst({
      where: { id: input.customerId, tenantId, deletedAt: null },
      select: { email: true },
    });
    if (!customer)
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    const byEmail = input.channel === 'email';
    if (byEmail && !customer.email && input.followupInDays === 0) {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'El inquilino no tiene email: envíalo por WhatsApp o crea un seguimiento.',
      });
    }
    // La propuesta se reserva antes de enviar nada: dos clics (o dos personas)
    // a la vez mandaban dos correos y creaban dos seguimientos.
    const created = await this.offers.createOnce({
      tenantId,
      customerId: input.customerId,
      kind: input.kind,
      message: draft.offerText,
      priceGross: opp.priceMonthlyGross,
      userId,
      metadata: { ...opp.offerMetadata, channel: input.channel },
      guardMs: REPROPOSE_GUARD_MS,
    });
    if (!created) {
      throw new ConflictException({
        code: 'already_proposed',
        message: 'Esta propuesta se acaba de enviar: espera unos minutos para repetirla.',
      });
    }
    let emailSent = false;
    if (byEmail && customer.email) {
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: customer.email,
        customerId: input.customerId,
        source: `opportunity:${input.kind}`,
        subject: input.subject ?? draft.subject,
        bodyText: input.body ?? draft.body,
        // Comercial: pie de baja y se omite si se da de baja antes de salir.
        marketing: true,
      });
      emailSent = true;
    }
    let followupId: string | null = null;
    if (input.followupInDays > 0) {
      const tz = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const due = todayInTimezone(tz?.timezone ?? 'Europe/Madrid');
      due.setUTCDate(due.getUTCDate() + input.followupInDays);
      const f = await this.prisma.withTenant(
        (tx) =>
          tx.customerFollowup.create({
            data: {
              tenantId,
              customerId: input.customerId,
              userId,
              title: `Seguimiento: ${OPPORTUNITY_LABELS[input.kind].toLowerCase()}`,
              note: emailSent
                ? 'Propuesta enviada por correo.'
                : input.channel === 'whatsapp'
                  ? 'Propuesta enviada por WhatsApp.'
                  : 'Proponer al inquilino.',
              dueDate: due,
            },
            select: { id: true },
          }),
        tenantId,
      );
      followupId = f.id;
    }
    if (input.kind === 'google_review') {
      // No pedírsela otra vez desde Valoraciones.
      await this.admin.review.updateMany({
        where: {
          tenantId,
          customerId: input.customerId,
          status: 'submitted',
          npsScore: { gte: 9 },
          googleRequestedAt: null,
        },
        data: { googleRequestedAt: new Date() },
      });
    }
    await this.audit.write({
      tenantId,
      userId,
      action: 'opportunity.proposed',
      entityType: 'Customer',
      entityId: input.customerId,
      changes: { kind: input.kind, emailSent, channel: input.channel },
    });
    return { emailSent, followupId };
  }

  /**
   * Proponer a varios a la vez: por correo, con el texto sugerido. Los que no
   * aplican, no tienen email o se acaban de proponer se saltan con su motivo.
   */
  async proposeBulk(
    tenantId: string,
    userId: string,
    input: ProposeBulkInput,
    scope: FacilityScope,
  ): Promise<ProposeBulkResultDto> {
    let sent = 0;
    const skipped: ProposeBulkResultDto['skipped'] = [];
    const withEmail = new Set(
      (
        await this.admin.customer.findMany({
          where: {
            tenantId,
            id: { in: [...new Set(input.items.map((i) => i.customerId))] },
            deletedAt: null,
            email: { not: null },
          },
          select: { id: true },
        })
      ).map((c) => c.id),
    );
    for (const item of input.items) {
      if (!withEmail.has(item.customerId)) {
        skipped.push({ customerId: item.customerId, kind: item.kind, reason: 'No tiene email' });
        continue;
      }
      try {
        await this.propose(
          tenantId,
          userId,
          {
            customerId: item.customerId,
            kind: item.kind,
            channel: 'email',
            followupInDays: input.followupInDays,
          },
          scope,
        );
        sent += 1;
      } catch (err) {
        const body = (err as { getResponse?: () => unknown }).getResponse?.() as
          | { message?: string }
          | undefined;
        skipped.push({
          customerId: item.customerId,
          kind: item.kind,
          reason: body?.message ?? 'No se ha podido enviar',
        });
      }
    }
    return { sent, skipped };
  }

  /** Descartar (para siempre) o posponer unos días una oportunidad. */
  async dismiss(
    tenantId: string,
    userId: string,
    input: DismissOpportunityInput,
    scope: FacilityScope,
  ): Promise<void> {
    await this.assertCustomerVisible(tenantId, input.customerId, scope);
    const until = input.days ? new Date(Date.now() + input.days * DAY) : null;
    await this.prisma.withTenant(
      (tx) =>
        tx.opportunityDismissal.upsert({
          where: {
            tenantId_customerId_kind: {
              tenantId,
              customerId: input.customerId,
              kind: input.kind,
            },
          },
          create: {
            tenantId,
            customerId: input.customerId,
            kind: input.kind,
            until,
            reason: input.reason?.trim() || null,
            userId,
          },
          update: { until, reason: input.reason?.trim() || null, userId, createdAt: new Date() },
        }),
      tenantId,
    );
  }

  async undismiss(
    tenantId: string,
    customerId: string,
    kind: OpportunityKind,
    scope: FacilityScope,
  ): Promise<void> {
    await this.assertCustomerVisible(tenantId, customerId, scope);
    await this.prisma.withTenant(
      (tx) => tx.opportunityDismissal.deleteMany({ where: { customerId, kind } }),
      tenantId,
    );
  }

  async listDismissed(tenantId: string, scope: FacilityScope): Promise<OpportunityDismissalDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.opportunityDismissal.findMany({
          where: {
            OR: [{ until: null }, { until: { gt: new Date() } }],
            customer: { deletedAt: null, ...customerScopeWhere(scope ?? null) },
          },
          include: {
            customer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            user: { select: { fullName: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 300,
        }),
      tenantId,
    );
    return rows.map((r) => ({
      customerId: r.customerId,
      customerName: nameOf(r.customer),
      kind: r.kind as OpportunityKind,
      until: r.until?.toISOString() ?? null,
      reason: r.reason,
      userName: r.user?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async assertCustomerVisible(
    tenantId: string,
    customerId: string,
    scope: FacilityScope,
  ): Promise<void> {
    const c = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: customerId, deletedAt: null, ...customerScopeWhere(scope ?? null) },
          select: { id: true },
        }),
      tenantId,
    );
    if (!c) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
  }
}
