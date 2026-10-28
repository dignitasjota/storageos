import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type LeadQuoteDto,
  type LeadQuoteInput,
  type SendLeadQuoteInput,
  type SendLeadQuoteResultDto,
} from '@storageos/shared';

import { formatEur } from '../../common/format';
import { AuditService, type AuditEntry } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { CouponsService } from '../coupons/coupons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Presupuesto a un contacto: el staff elige local, tamaño, meses del primer
 * pago, cupón y seguro; se calcula lo que pagaría (con IVA) y se le envía con
 * un enlace a la reserva online ya rellenada. La reserva se atribuye al
 * contacto por su email y al presupuesto por las variables del enlace.
 */
@Injectable()
export class LeadQuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly coupons: CouponsService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async preview(tenantId: string, leadId: string, input: LeadQuoteInput): Promise<LeadQuoteDto> {
    const lead = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findFirst({
          where: { id: leadId, deletedAt: null },
          select: { firstName: true, companyName: true, email: true },
        }),
      tenantId,
    );
    if (!lead)
      throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });

    const [tenant, unit, plan] = await Promise.all([
      this.admin.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
      }),
      this.admin.unit.findFirst({
        where: {
          tenantId,
          facilityId: input.facilityId,
          unitTypeId: input.unitTypeId,
          status: 'available',
        },
        orderBy: [{ basePriceMonthly: 'asc' }, { code: 'asc' }],
        select: {
          basePriceMonthly: true,
          areaM2: true,
          facility: { select: { name: true, publicSlug: true, preOpening: true } },
          unitType: { select: { name: true, propertyKind: true, defaultDepositAmount: true } },
        },
      }),
      input.insurancePlanId
        ? this.admin.insurancePlan.findFirst({
            where: { id: input.insurancePlanId, tenantId, isActive: true },
            select: { name: true, monthlyPrice: true, taxRate: true },
          })
        : Promise.resolve(null),
    ]);
    if (!unit) {
      throw new ConflictException({
        code: 'no_units_available',
        message: 'No quedan trasteros libres de ese tamaño en ese local.',
      });
    }
    if (input.insurancePlanId && !plan) {
      throw new BadRequestException({
        code: 'insurance_plan_not_found',
        message: 'Plan de seguro no válido',
      });
    }

    // Un contacto que ya fue cliente (contrato firmado) no puede usar un cupón
    // «solo clientes nuevos»: la reserva online se lo rechazaría.
    const isNewCustomer = lead.email
      ? !(await this.admin.customer.findFirst({
          where: {
            tenantId,
            deletedAt: null,
            email: { equals: lead.email, mode: 'insensitive' },
            contracts: { some: { signedAt: { not: null } } },
          },
          select: { id: true },
        }))
      : true;
    // Local por abrir: se reserva pagando una mensualidad.
    const months = unit.facility.preOpening ? 1 : input.months;
    const base = await this.coupons.quoteFirstPayment(tenantId, {
      monthlyPrice: Number(unit.basePriceMonthly),
      months,
      unitTypeId: input.unitTypeId,
      facilityId: input.facilityId,
      propertyKind: unit.unitType.propertyKind,
      deposit: Number(unit.unitType.defaultDepositAmount ?? 0),
      couponCode: input.couponCode,
      isNewCustomer,
      preOpening: unit.facility.preOpening,
    });
    const insurance = plan
      ? round2(Number(plan.monthlyPrice) * (1 + Number(plan.taxRate) / 100) * months)
      : 0;
    const quote = {
      ...base,
      insuranceWithVat: insurance,
      totalToPay: round2(base.totalToPay + insurance),
    };
    const monthlyWithVat = round2(
      Number(unit.basePriceMonthly) * (1 + base.vatRate / 100) +
        (plan ? Number(plan.monthlyPrice) * (1 + Number(plan.taxRate) / 100) : 0),
    );

    const couponOk = quote.coupon?.valid ? quote.coupon.code : undefined;
    const bookUrl = this.bookUrl(tenant, {
      facilityId: input.facilityId,
      facilitySlug: unit.facility.publicSlug,
      unitTypeId: input.unitTypeId,
      months: months,
      coupon: couponOk,
    });

    const name = lead.firstName ?? lead.companyName ?? '';
    const lines = [
      `${unit.unitType.name}${unit.areaM2 ? ` (${Number(unit.areaM2)} m²)` : ''} en ${unit.facility.name}.`,
      '',
      months > 1
        ? `Primer pago de ${months} meses: ${formatEur(quote.rentTotalWithVat)} (IVA incl.)${quote.freeMonths > 0 ? `, con ${quote.freeMonths} ${quote.freeMonths === 1 ? 'mes gratis' : 'meses gratis'}` : quote.discountAmount > 0 ? `, con un descuento de ${formatEur(quote.discountAmount)}` : ''}.`
        : `Cuota mensual: ${formatEur(round2(Number(unit.basePriceMonthly) * (1 + base.vatRate / 100)))} (IVA incl.)${quote.discountAmount > 0 ? `; el primer mes con un descuento de ${formatEur(quote.discountAmount)}` : ''}.`,
      ...(plan
        ? [`Protección de contenido «${plan.name}»: ${formatEur(insurance)} (IVA incl.).`]
        : []),
      ...(quote.deposit > 0
        ? [`Fianza: ${formatEur(quote.deposit)} (se devuelve al terminar).`]
        : []),
      `Total a pagar al reservar: ${formatEur(quote.totalToPay)}.`,
      ...(unit.facility.preOpening
        ? [
            'El local aún no ha abierto: reservas ahora pagando la primera mensualidad, que cubre tu primer mes desde el día de apertura. Puedes cancelar sin coste en los 14 días siguientes.',
          ]
        : quote.prorated
          ? ['Si entras a mitad de mes, el primer pago es solo por los días que quedan.']
          : []),
      ...(months > 1 ? [`Después, ${formatEur(monthlyWithVat)} al mes.`] : []),
    ];
    const body = `Hola${name ? ` ${name}` : ''}:\n\nGracias por tu interés. Este es el presupuesto que te hemos preparado:\n\n${lines.join('\n')}\n\nPuedes reservarlo online en un par de minutos (el precio y el cupón ya están puestos):\n${bookUrl}\n\nEl precio puede cambiar si el trastero se alquila antes. Cualquier duda, responde a este correo.\n\n${tenant.name}`;

    return {
      quote,
      facilityName: unit.facility.name,
      unitTypeName: unit.unitType.name,
      areaM2: unit.areaM2 ? Number(unit.areaM2) : null,
      insuranceName: plan?.name ?? null,
      monthlyWithVat,
      bookUrl,
      subject: `Tu presupuesto de trastero en ${unit.facility.name}`,
      body,
    };
  }

  async send(
    tenantId: string,
    userId: string,
    leadId: string,
    input: SendLeadQuoteInput,
    meta: Pick<AuditEntry, 'ipAddress' | 'userAgent'>,
  ): Promise<SendLeadQuoteResultDto> {
    const lead = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findFirst({
          where: { id: leadId, deletedAt: null },
          select: { id: true, email: true, status: true },
        }),
      tenantId,
    );
    if (!lead)
      throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });
    if (!lead.email) {
      throw new BadRequestException({
        code: 'lead_without_email',
        message: 'Este contacto no tiene email',
      });
    }
    const draft = await this.preview(tenantId, leadId, input);
    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: lead.email,
      subject: input.subject ?? draft.subject,
      bodyText: input.body ?? draft.body,
      leadId,
      source: 'lead.quote',
    });
    await this.prisma.withTenant(
      (tx) =>
        tx.lead.update({
          where: { id: leadId },
          data: {
            preferredFacilityId: input.facilityId,
            preferredUnitTypeId: input.unitTypeId,
            ...(lead.status === 'new' ? { status: 'contacted', contactedAt: new Date() } : {}),
          },
        }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'lead.quote_sent',
      entityType: 'Lead',
      entityId: leadId,
      changes: {
        facilityId: input.facilityId,
        unitTypeId: input.unitTypeId,
        months: draft.quote.months,
        total: draft.quote.totalToPay,
        ...(draft.quote.coupon?.valid ? { coupon: draft.quote.coupon.code } : {}),
      },
      ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    });
    return { sentTo: lead.email };
  }

  private bookUrl(
    tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
    p: {
      facilityId: string;
      facilitySlug: string | null;
      unitTypeId: string;
      months: number;
      coupon?: string | undefined;
    },
  ): string {
    const qs = new URLSearchParams();
    let base: string;
    if (tenant.customDomain && tenant.customDomainVerifiedAt) {
      base = `https://${tenant.customDomain}/reservar${p.facilitySlug ? `/${encodeURIComponent(p.facilitySlug)}` : ''}`;
      if (!p.facilitySlug) qs.set('facilityId', p.facilityId);
    } else {
      base = `${this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3000'}/book/${encodeURIComponent(tenant.slug)}`;
      qs.set('facilityId', p.facilityId);
    }
    qs.set('unitTypeId', p.unitTypeId);
    if (p.coupon) qs.set('coupon', p.coupon);
    if (p.months > 1) qs.set('months', String(p.months));
    qs.set('utm_source', 'presupuesto');
    qs.set('utm_medium', 'email');
    qs.set('utm_campaign', 'presupuesto');
    return `${base}?${qs.toString()}`;
  }
}
