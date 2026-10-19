import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
import { formatEur } from '../../common/format';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

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

/**
 * Oportunidades sobre los inquilinos: qué ofrecer a quién y por qué, a partir
 * de lo que tienen contratado y de lo que miran en su área de clientes. El
 * sistema solo sugiere y redacta la propuesta: no cambia nada del contrato.
 */
@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
    private readonly config: ConfigService,
  ) {}

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
    const hasInsurance = await tenantHasFeature(this.admin, tenantId, 'insurance');
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
            ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
          },
          select: {
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
          where: { createdAt: { gte: new Date(now.getTime() - 60 * DAY) } },
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
        tx.sepaMandate.findMany({ where: { status: 'active' }, select: { customerId: true } }),
        tx.unitChangeRequest.findMany({
          where: { status: 'pending' },
          select: { customerId: true },
        }),
        tx.communication.groupBy({
          by: ['customerId', 'source'],
          where: { customerId: { not: null }, source: { startsWith: 'opportunity:' } },
          _max: { createdAt: true },
        }),
        tx.invoice.groupBy({
          by: ['customerId'],
          where: {
            customerId: { not: null },
            deletedAt: null,
            status: { in: ['overdue', 'paid'] },
            dueDate: { gte: new Date(now.getTime() - 90 * DAY) },
            OR: [{ status: 'overdue' }, { paidAt: { not: null } }],
          },
          _count: { _all: true },
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
      const wantsChange = new Set(changeRequests.map((r) => r.customerId));
      const proposedBy = new Map<string, Date>();
      for (const p of proposed) {
        if (p.customerId && p._max.createdAt) {
          proposedBy.set(
            `${p.customerId}:${p.source!.slice('opportunity:'.length)}`,
            p._max.createdAt,
          );
        }
      }
      const hadOverdue = new Set(overdue.map((o) => o.customerId!));

      type Row = (typeof contracts)[number];
      const byCustomer = new Map<string, Row[]>();
      for (const c of contracts)
        byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);

      const out: OpportunityDto[] = [];
      const push = (
        rows: Row[],
        kind: OpportunityKind,
        o: Pick<
          OpportunityDto,
          'reason' | 'offer' | 'priceMonthlyGross' | 'monthlyValue' | 'score'
        >,
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
          });
        }

        // Trastero mayor: lo ha mirado o ha pedido cambiar.
        const larger = interest('larger_unit');
        if (larger || wantsChange.has(customerId)) {
          const current = rows[0]!;
          const area = Number(current.unit.areaM2 ?? 0);
          const next = available.find(
            (u) =>
              u.facilityId === current.unit.facilityId &&
              Number(u.areaM2 ?? 0) > area &&
              u.unitType.propertyKind !== 'housing',
          );
          if (next) {
            const diff = round2(Number(next.basePriceMonthly) - Number(current.priceMonthly));
            push([current], 'larger_unit', {
              reason: wantsChange.has(customerId)
                ? 'Ha pedido cambiar de trastero.'
                : 'Miró trasteros más grandes en su área de clientes.',
              offer: `${next.unitType.name} (${Number(next.areaM2 ?? 0)} m²) en ${next.facility.name} por ${formatEur(gross(Number(next.basePriceMonthly)))}/mes (IVA incl.)`,
              priceMonthlyGross: gross(Number(next.basePriceMonthly)),
              monthlyValue: Math.max(0, diff),
              score: 60,
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
            monthlyValue: nightPrice,
            score: 35 + Math.min(30, deniedCount * 10),
          });
        }

        // Domiciliar: paga a mano.
        if (!chargeable.has(customerId) && !mandate.has(customerId)) {
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

  async draft(
    tenantId: string,
    customerId: string,
    kind: OpportunityKind,
    scope: FacilityScope,
  ): Promise<OpportunityDraftDto> {
    const { items } = await this.list(tenantId, scope);
    const opp = items.find((i) => i.customerId === customerId && i.kind === kind);
    if (!opp) {
      throw new NotFoundException({
        code: 'opportunity_not_found',
        message: 'Esta oportunidad ya no aplica a este inquilino.',
      });
    }
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    const customer = await this.admin.customer.findUniqueOrThrow({
      where: { id: customerId },
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
    };
  }

  async propose(
    tenantId: string,
    userId: string,
    input: ProposeOpportunityInput,
    scope: FacilityScope,
  ): Promise<ProposeOpportunityResultDto> {
    const draft = await this.draft(tenantId, input.customerId, input.kind, scope);
    const customer = await this.admin.customer.findFirst({
      where: { id: input.customerId, tenantId, deletedAt: null },
      select: { email: true },
    });
    if (!customer)
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    if (!customer.email && input.followupInDays === 0) {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'El inquilino no tiene email: envíalo por WhatsApp o crea un seguimiento.',
      });
    }
    let emailSent = false;
    if (customer.email) {
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: customer.email,
        customerId: input.customerId,
        source: `opportunity:${input.kind}`,
        subject: input.subject ?? draft.subject,
        bodyText: input.body ?? draft.body,
      });
      emailSent = true;
    }
    let followupId: string | null = null;
    if (input.followupInDays > 0) {
      const due = new Date(Date.now() + input.followupInDays * DAY).toISOString().slice(0, 10);
      const f = await this.prisma.withTenant(
        (tx) =>
          tx.customerFollowup.create({
            data: {
              tenantId,
              customerId: input.customerId,
              userId,
              title: `Seguimiento: ${OPPORTUNITY_LABELS[input.kind].toLowerCase()}`,
              note: emailSent ? 'Propuesta enviada por correo.' : 'Proponer al inquilino.',
              dueDate: new Date(due),
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
      changes: { kind: input.kind, emailSent },
    });
    return { emailSent, followupId };
  }
}
