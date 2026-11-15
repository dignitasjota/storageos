import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OPPORTUNITY_LABELS,
  type OpportunitiesDto,
  type OpportunityDraftDto,
  type OpportunityDto,
  type OpportunityKind,
  OpportunityKindEnum,
  type PortalInterestInput,
  type ProposeOpportunityInput,
  type ProposeOpportunityResultDto,
} from '@storageos/shared';

import { type FacilityScope } from '../../common/facility-scope';
import { formatEur, todayInTimezone } from '../../common/format';
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
          select: { nightPassEnabled: true, nightPassPrice: true },
        }),
        tx.contract.findMany({
          where: {
            deletedAt: null,
            status: 'active',
            ...(onlyCustomerId ? { customerId: onlyCustomerId } : {}),
            // Las propuestas son comunicaciones comerciales: no a quien se dio de
            // baja. El inquilino de prueba de la puesta en marcha tampoco.
            customer: { marketingOptOutAt: null, deletedAt: null, isTest: false },
            ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
          },
          select: {
            id: true,
            customerId: true,
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
        const last = proposedBy.get(`${c.customerId}:${kind}`) ?? null;
        out.push({
          id: `${c.customerId}:${kind}`,
          kind,
          customerId: c.customerId,
          customerName: nameOf(c.customer),
          email: c.customer.email,
          phone: c.customer.phone,
          units: rows.map((r) => r.unit.code),
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
      for (const [customerId, rows] of byCustomer) {
        const interest = (k: string) => interestBy.get(`${customerId}:${k}`);

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

    items.sort((a, b) => b.score - a.score || b.monthlyValue - a.monthlyValue);
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

  private async buildDraft(tenantId: string, opp: OpportunityDto): Promise<OpportunityDraftDto> {
    const kind = opp.kind;
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
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
}
