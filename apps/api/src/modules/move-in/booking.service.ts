import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type BookingCreatedPayload } from '../automations/domain-events';
import { ContractsService } from '../contracts/contracts.service';
import { CouponsService } from '../coupons/coupons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { ReferralsService } from '../referrals/referrals.service';

import { SignaturesService } from './signatures.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  BookingQuoteInput,
  FirstPaymentQuoteDto,
  BookingAvailabilityDto,
  BookingResultDto,
  CaptureBookingLeadInput,
  PublicBookingInput,
} from '@storageos/shared';

/** `ana.garcia@gmail.com` → `a***a@gmail.com` (para decir a dónde se envió el enlace). */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.trim().toLowerCase().split('@');
  const masked = user.length <= 2 ? `${user[0] ?? ''}***` : `${user[0]}***${user[user.length - 1]}`;
  return domain ? `${masked}@${domain}` : masked;
}

/** Plazo (horas) para firmar+pagar antes de que el hold de la unidad expire. */
const BOOKING_HOLD_HOURS = 72;

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly signatures: SignaturesService,
    private readonly referrals: ReferralsService,
    private readonly coupons: CouponsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Captura email-first: en cuanto el visitante deja su email en el booking,
   * guardamos un lead para no perderlo si abandona antes de completar la reserva
   * (visibilidad + remarketing). Idempotente por email: si ya hay un lead `new`
   * reciente del mismo email, lo enriquece (local/tipo preferidos) en vez de
   * duplicar. Best-effort: nunca lanza (no debe romper el flujo del formulario).
   */
  async captureLead(
    slug: string,
    input: CaptureBookingLeadInput,
    meta: RequestMeta,
  ): Promise<{ captured: boolean }> {
    try {
      if (input.website && input.website.trim() !== '') return { captured: false };
      const tenant = await this.admin.tenant.findUnique({ where: { slug } });
      if (!tenant || tenant.deletedAt) return { captured: false };
      const tenantId = tenant.id;

      await this.prisma.withTenant(async (tx) => {
        // Dedup: un lead `new` del mismo email creado en las últimas 24 h (evita
        // duplicar mientras el visitante teclea/reintenta).
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const existing = await tx.lead.findFirst({
          where: { email: input.email, status: 'new', createdAt: { gte: since }, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        const data = {
          ...(input.facilityId ? { preferredFacilityId: input.facilityId } : {}),
          ...(input.unitTypeId ? { preferredUnitTypeId: input.unitTypeId } : {}),
          ...(input.firstName?.trim() ? { firstName: input.firstName.trim() } : {}),
        };
        if (existing) {
          if (Object.keys(data).length > 0) {
            await tx.lead.update({ where: { id: existing.id }, data });
          }
          return;
        }
        await tx.lead.create({
          data: {
            tenantId,
            source: 'widget',
            email: input.email,
            firstName: input.firstName?.trim() || null,
            preferredFacilityId: input.facilityId ?? null,
            preferredUnitTypeId: input.unitTypeId ?? null,
            utmSource: input.utmSource ?? null,
            utmMedium: input.utmMedium ?? null,
            utmCampaign: input.utmCampaign ?? null,
            metadata: {
              origin: 'booking',
              userAgent: meta.userAgent ?? null,
              ipAddress: meta.ipAddress ?? null,
            },
          },
        });
      }, tenantId);
      return { captured: true };
    } catch (err) {
      this.logger.warn(`[booking] captura de lead best-effort falló: ${(err as Error).message}`);
      return { captured: false };
    }
  }

  /** Disponibilidad pública por local y tipo (move-in). */
  async availability(slug: string): Promise<BookingAvailabilityDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const [facilities, unitTypes, grouped] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId: tenant.id, deletedAt: null },
        select: { id: true, name: true, publicSlug: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, defaultPriceMonthly: true },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id, status: 'available' },
        _count: { _all: true },
      }),
    ]);

    const availByFacilityType = new Map<string, number>();
    for (const g of grouped) {
      availByFacilityType.set(`${g.facilityId}:${g.unitTypeId}`, g._count._all);
    }

    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      googleAnalyticsId: tenant.googleAnalyticsId,
      facilities: facilities
        .map((f) => ({
          id: f.id,
          name: f.name,
          publicSlug: f.publicSlug,
          unitTypes: unitTypes
            .map((t) => ({
              id: t.id,
              name: t.name,
              available: availByFacilityType.get(`${f.id}:${t.id}`) ?? 0,
              priceMonthly: Number(t.defaultPriceMonthly),
            }))
            .filter((t) => t.available > 0),
        }))
        .filter((f) => f.unitTypes.length > 0),
    };
  }

  /**
   * Público: resumen de lo que se paga al reservar (meses elegidos, cupón,
   * IVA y fianza) con el trastero que se asignaría.
   */
  async quoteBooking(slug: string, input: BookingQuoteInput): Promise<FirstPaymentQuoteDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    return this.quoteFor(tenant.id, {
      facilityId: input.facilityId,
      unitTypeId: input.unitTypeId,
      months: input.months,
      ...(input.couponCode ? { couponCode: input.couponCode } : {}),
    });
  }

  private async quoteFor(
    tenantId: string,
    input: {
      facilityId: string;
      unitTypeId: string;
      months: number;
      couponCode?: string | undefined;
      /** Solo al reservar (no en el resumen público: diría si un email es cliente). */
      email?: string | undefined;
    },
  ): Promise<FirstPaymentQuoteDto> {
    const unit = await this.admin.unit.findFirst({
      where: {
        tenantId,
        facilityId: input.facilityId,
        unitTypeId: input.unitTypeId,
        status: 'available',
      },
      orderBy: { code: 'asc' },
      select: {
        basePriceMonthly: true,
        unitType: { select: { propertyKind: true, defaultDepositAmount: true } },
      },
    });
    if (!unit) {
      throw new ConflictException({
        code: 'no_units_available',
        message: 'No quedan trasteros disponibles de ese tipo',
      });
    }
    const customer = input.email
      ? await this.admin.customer.findFirst({
          where: {
            tenantId,
            email: { equals: input.email.trim(), mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true, depositExempt: true },
        })
      : null;
    return this.coupons.quoteFirstPayment(tenantId, {
      monthlyPrice: Number(unit.basePriceMonthly),
      months: input.months,
      unitTypeId: input.unitTypeId,
      facilityId: input.facilityId,
      propertyKind: unit.unitType.propertyKind,
      deposit: customer?.depositExempt ? 0 : Number(unit.unitType.defaultDepositAmount ?? 0),
      couponCode: input.couponCode,
      isNewCustomer: customer ? await this.coupons.isNewCustomer(tenantId, customer.id) : null,
      customerId: customer?.id ?? null,
      publicMessages: true,
    });
  }

  /** Público: alta self-service → crea cliente + contrato draft + token de firma. */
  async createBooking(
    slug: string,
    input: PublicBookingInput,
    meta: RequestMeta,
  ): Promise<BookingResultDto> {
    // Honeypot anti-bot: si viene relleno, rechazamos sin crear nada.
    if (input.website && input.website.trim() !== '') {
      throw new BadRequestException({ code: 'spam_detected', message: 'Solicitud no válida' });
    }
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const tenantId = tenant.id;
    const couponCode = input.couponCode?.trim() || undefined;
    // El cupón se comprueba antes de reservar el trastero: si no vale, no se
    // crea nada y el visitante ve el motivo.
    if (couponCode) {
      const quote = await this.quoteFor(tenantId, {
        facilityId: input.facilityId,
        unitTypeId: input.unitTypeId,
        months: input.months,
        couponCode,
        email: input.customer.email,
      });
      if (quote.coupon && !quote.coupon.valid) {
        throw new BadRequestException({
          code: 'coupon_not_valid',
          message: quote.coupon.message ?? 'El cupón no es válido',
        });
      }
    }

    const { unitId, customerId, customerCreated, priceMonthly, depositAmount } =
      await this.prisma.withTenant(async (tx) => {
        // Hold de la unidad: dos bookings simultáneos sobre el último trastero
        // no deben llevarse la misma unidad. Serializamos la selección+reserva
        // por (tenant, tipo) con un advisory lock de transacción (se libera al
        // commit); la segunda tx espera y elige OTRA unidad libre. Sin esto, el
        // contrato draft deja la unidad `available` hasta firmar (ventana de 72 h)
        // → otro booking la tomaba.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${input.unitTypeId}))`;
        const facility = await tx.facility.findFirst({
          where: { id: input.facilityId, deletedAt: null },
        });
        if (!facility) {
          throw new NotFoundException({
            code: 'facility_not_found',
            message: 'Local no encontrado',
          });
        }
        const unitType = await tx.unitType.findFirst({
          where: { id: input.unitTypeId },
          select: { defaultDepositAmount: true },
        });
        const unit = await tx.unit.findFirst({
          where: {
            facilityId: input.facilityId,
            unitTypeId: input.unitTypeId,
            status: 'available',
          },
          orderBy: { code: 'asc' },
        });
        if (!unit) {
          throw new ConflictException({
            code: 'no_units_available',
            message: 'No quedan trasteros disponibles de ese tipo',
          });
        }
        // Reserva la unidad (available → reserved): queda fuera de la
        // disponibilidad hasta que se firme (→ occupied) o expire el plazo de
        // pago (el BookingExpiryCron cancela y libera → available).
        await tx.unit.update({ where: { id: unit.id }, data: { status: 'reserved' } });
        await tx.unitStatusHistory.create({
          data: {
            tenantId,
            unitId: unit.id,
            previousStatus: 'available',
            newStatus: 'reserved',
            changedByUserId: null,
            reason: 'Reserva online (booking self-service)',
          },
        });
        // Reutiliza el cliente por email si ya existe; si no, lo crea.
        // Sin distinguir mayúsculas: «Ana@…» es el mismo inquilino que «ana@…».
        const existing = await tx.customer.findFirst({
          where: {
            email: { equals: input.customer.email.trim(), mode: 'insensitive' },
            deletedAt: null,
          },
        });
        const customer =
          existing ??
          (await tx.customer.create({
            data: {
              tenantId,
              customerType: 'individual',
              firstName: input.customer.firstName.trim(),
              lastName: input.customer.lastName.trim(),
              email: input.customer.email.trim().toLowerCase(),
              phone: input.customer.phone?.trim() || null,
              documentNumber: input.customer.documentNumber?.trim() || null,
              country: 'ES',
            },
          }));
        // Referido (best-effort, solo para clientes nuevos).
        if (!existing && input.referralCode && input.referralCode.trim()) {
          await this.referrals.registerInTx(tx, tenantId, input.referralCode, customer.id);
        }
        return {
          unitId: unit.id,
          customerId: customer.id,
          customerCreated: !existing,
          priceMonthly: Number(unit.basePriceMonthly),
          depositAmount: Number(unitType?.defaultDepositAmount ?? 0),
        };
      }, tenantId);

    let contract: Awaited<ReturnType<ContractsService['create']>>;
    try {
      contract = await this.contracts.create({
        tenantId,
        userId: null,
        meta,
        input: {
          customerId,
          unitId,
          startDate: input.startDate,
          billingCycle: 'monthly',
          billingIntervalMonths: 1,
          firstPaymentMonths: input.months,
          ...(couponCode ? { couponCode } : {}),
          prepayDiscountPct: 0,
          priceMonthly,
          discountAmount: 0,
          depositAmount,
          depositPaymentMethod: 'online',
          autoRenew: true,
          cancellationNoticeDays: 15,
        },
      });
    } catch (err) {
      // Sin contrato (p. ej. el cupón se agotó entretanto): el trastero vuelve
      // a estar disponible.
      await this.admin.unit
        .updateMany({ where: { id: unitId, status: 'reserved' }, data: { status: 'available' } })
        .catch(() => undefined);
      // El cliente recién creado para esta reserva no se queda suelto.
      if (customerCreated) {
        await this.admin.referral
          .deleteMany({ where: { tenantId, referredCustomerId: customerId } })
          .catch(() => undefined);
        await this.admin.customer.delete({ where: { id: customerId } }).catch(() => undefined);
      }
      throw err;
    }

    // Marketing: si había un lead sin convertir para este email (captureLead
    // email-first, u otro origen), se marca `won` con la conversión — así el
    // informe de rendimiento de marketing cuenta esta reserva. Si no había
    // ninguno (el visitante saltó el paso email-first), se crea ya `won` para
    // no perder la atribución UTM del enlace por el que llegó. Best-effort en
    // su propia transacción: nunca debe bloquear ni revertir la reserva.
    try {
      await this.prisma.withTenant(async (tx) => {
        const existingLead = await tx.lead.findFirst({
          where: {
            email: { equals: input.customer.email.trim(), mode: 'insensitive' },
            status: { in: ['new', 'contacted', 'qualified'] },
            deletedAt: null,
          },
          orderBy: { createdAt: 'desc' },
        });
        if (existingLead) {
          await tx.lead.update({
            where: { id: existingLead.id },
            data: {
              status: 'won',
              wonAt: new Date(),
              convertedCustomerId: customerId,
              convertedContractId: contract.id,
              // La reserva cuenta para el origen por el que llegó (anuncio,
              // flyer, landing…), aunque el contacto ya existiera de antes.
              ...(input.utmSource || input.utmMedium || input.utmCampaign
                ? {
                    utmSource: input.utmSource ?? null,
                    utmMedium: input.utmMedium ?? null,
                    utmCampaign: input.utmCampaign ?? null,
                  }
                : {}),
            },
          });
        } else {
          await tx.lead.create({
            data: {
              tenantId,
              source: 'widget',
              email: input.customer.email.trim().toLowerCase(),
              firstName: input.customer.firstName.trim(),
              lastName: input.customer.lastName.trim(),
              status: 'won',
              wonAt: new Date(),
              convertedCustomerId: customerId,
              convertedContractId: contract.id,
              utmSource: input.utmSource ?? null,
              utmMedium: input.utmMedium ?? null,
              utmCampaign: input.utmCampaign ?? null,
            },
          });
        }
      }, tenantId);
    } catch (err) {
      this.logger.warn(`[booking] tracking de lead best-effort falló: ${(err as Error).message}`);
    }

    // Plazo del hold: si el inquilino no firma+paga en 72 h, el BookingExpiryCron
    // cancela el contrato (→ libera la unidad reservada). Sin este deadline, un
    // booking abandonado dejaría la unidad `reserved` para siempre.
    const holdDeadline = new Date(Date.now() + BOOKING_HOLD_HOURS * 60 * 60 * 1000);
    await this.admin.contract.update({
      where: { id: contract.id },
      data: { firstPaymentDeadline: holdDeadline },
    });

    this.events.emit(DOMAIN_EVENTS.booking_created, {
      tenantId,
      contractId: contract.id,
      customerId,
    } satisfies BookingCreatedPayload);

    // El email ya era de un inquilino: quien rellena el formulario puede no ser
    // él (el enlace de firma da acceso a su área de clientes, con sus códigos
    // de acceso). El enlace se envía solo a su email; aquí no se devuelve.
    if (!customerCreated) {
      const sent = await this.signatures.requestSignature(tenantId, contract.id, {
        selfServiceBooking: true,
      });
      return {
        contractId: contract.id,
        signingToken: null,
        signingLinkSentTo: sent.emailed ? maskEmail(input.customer.email) : null,
      };
    }
    const { token } = await this.signatures.generateSigningToken(contract.id);
    return { contractId: contract.id, signingToken: token, signingLinkSentTo: null };
  }
}
