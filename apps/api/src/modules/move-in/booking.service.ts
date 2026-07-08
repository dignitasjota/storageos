import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ContractsService } from '../contracts/contracts.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { ReferralsService } from '../referrals/referrals.service';

import { SignaturesService } from './signatures.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  BookingAvailabilityDto,
  BookingResultDto,
  PublicBookingInput,
} from '@storageos/shared';

/** Plazo (horas) para firmar+pagar antes de que el hold de la unidad expire. */
const BOOKING_HOLD_HOURS = 72;

@Injectable()
export class BookingService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly signatures: SignaturesService,
    private readonly referrals: ReferralsService,
  ) {}

  /** Disponibilidad pública por local y tipo (move-in). */
  async availability(slug: string): Promise<BookingAvailabilityDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const [facilities, unitTypes, grouped] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId: tenant.id, deletedAt: null },
        select: { id: true, name: true },
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
      facilities: facilities
        .map((f) => ({
          id: f.id,
          name: f.name,
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

    const { unitId, customerId, priceMonthly, depositAmount } = await this.prisma.withTenant(
      async (tx) => {
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
        const existing = await tx.customer.findFirst({
          where: { email: input.customer.email, deletedAt: null },
        });
        const customer =
          existing ??
          (await tx.customer.create({
            data: {
              tenantId,
              customerType: 'individual',
              firstName: input.customer.firstName.trim(),
              lastName: input.customer.lastName.trim(),
              email: input.customer.email,
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
          priceMonthly: Number(unit.basePriceMonthly),
          depositAmount: Number(unitType?.defaultDepositAmount ?? 0),
        };
      },
      tenantId,
    );

    const contract = await this.contracts.create({
      tenantId,
      userId: null,
      meta,
      input: {
        customerId,
        unitId,
        startDate: input.startDate,
        billingCycle: 'monthly',
        priceMonthly,
        discountAmount: 0,
        depositAmount,
        autoRenew: true,
        cancellationNoticeDays: 15,
      },
    });

    // Plazo del hold: si el inquilino no firma+paga en 72 h, el BookingExpiryCron
    // cancela el contrato (→ libera la unidad reservada). Sin este deadline, un
    // booking abandonado dejaría la unidad `reserved` para siempre.
    const holdDeadline = new Date(Date.now() + BOOKING_HOLD_HOURS * 60 * 60 * 1000);
    await this.admin.contract.update({
      where: { id: contract.id },
      data: { firstPaymentDeadline: holdDeadline },
    });

    const { token } = await this.signatures.generateSigningToken(contract.id);
    return { contractId: contract.id, signingToken: token };
  }
}
