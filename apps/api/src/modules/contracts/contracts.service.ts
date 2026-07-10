import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { resolvePlanFeatures } from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { isAtLeast, isGreaterThan, subtractAmounts, toCents } from '../../common/money';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaService } from '../database/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';

import { buildContractTermsText } from './contract-terms';
import { PricingService } from './pricing.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DomainEventPayload, UnitAvailablePayload } from '../automations/domain-events';
import type { Contract, ContractStatus, Prisma, UnitStatus } from '@storageos/database';
import type {
  AddContractNoteInput,
  CancelContractInput,
  ChangeContractPriceInput,
  ContractDto,
  ContractEventDto,
  ContractStatusValue,
  CreateContractInput,
  PortalContractDto,
  SettleDepositInput,
  UpdateContractInput,
} from '@storageos/shared';

const ALLOWED_TRANSITIONS: Record<ContractStatusValue, ContractStatusValue[]> = {
  draft: ['active', 'cancelled'],
  active: ['ending', 'ended', 'cancelled'],
  ending: ['ended', 'cancelled'],
  ended: [],
  cancelled: [],
};

type ContractWithRelations = Contract & {
  customer: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: 'individual' | 'business';
  };
  unit: { code: string; facilityId: string; facility: { name: string } };
  insurancePlan: { name: string } | null;
};

interface ListFilters {
  status?: ContractStatusValue;
  customerId?: string;
  facilityId?: string;
  unitId?: string;
  includeDeleted?: boolean;
  /** Permisos por local: si está, solo contratos de unidades de esos locales. */
  facilityScope?: string[] | null;
}

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly eventBus: EventEmitter2,
    private readonly promotions: PromotionsService,
    private readonly invoices: InvoicesService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<ContractDto[]> {
    const where: Prisma.ContractWhereInput = {};
    if (!filters.includeDeleted) where.deletedAt = null;
    if (filters.status) where.status = filters.status as ContractStatus;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.unitId) where.unitId = filters.unitId;
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return []; // local pedido fuera del scope del usuario
    if (facFilter) where.unit = { facilityId: { in: facFilter } };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }],
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
              },
            },
            insurancePlan: { select: { name: true } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Contratos activos/en baja que vencen en los próximos `days` (renovación). */
  async listRenewals(tenantId: string, days = 60): Promise<ContractDto[]> {
    const now = new Date();
    const limit = new Date(now.getTime() + days * 86_400_000);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            deletedAt: null,
            status: { in: ['active', 'ending'] as ContractStatus[] },
            endDate: { not: null, gte: now, lte: limit },
          },
          orderBy: [{ endDate: 'asc' }],
          include: {
            customer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            unit: {
              select: { code: true, facilityId: true, facility: { select: { name: true } } },
            },
            insurancePlan: { select: { name: true } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<ContractDto> {
    return this.toDto(await this.findOrThrow(tenantId, id, facilityScope));
  }

  async events(
    tenantId: string,
    contractId: string,
    facilityScope?: string[] | null,
  ): Promise<ContractEventDto[]> {
    await this.findOrThrow(tenantId, contractId, facilityScope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contractEvent.findMany({
          where: { contractId },
          orderBy: { occurredAt: 'desc' },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      payload: (r.payload as Record<string, unknown>) ?? {},
      createdByUserId: r.createdByUserId,
      createdByName: r.createdBy?.fullName ?? null,
      occurredAt: r.occurredAt.toISOString(),
    }));
  }

  async create(args: {
    tenantId: string;
    userId: string | null;
    input: CreateContractInput;
    meta: RequestMeta;
    /** Permisos por local: la unidad debe estar en el scope del usuario. */
    facilityScope?: string[] | null;
  }): Promise<ContractDto> {
    const { tenantId, input } = args;
    // Gating por plan: el seguro requiere la feature `insurance`.
    if (input.insurancePlanId) await this.assertInsuranceFeature(tenantId);
    const created = await this.prisma.withTenant(async (tx) => {
      // Validar customer y unit pertenecientes a este tenant.
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, deletedAt: null },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      const unit = await tx.unit.findUnique({ where: { id: input.unitId } });
      if (!unit) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
      assertFacilityAllowed(args.facilityScope, unit.facilityId);
      // En draft permitimos crear el contrato aunque el unit no este available
      // (p.ej. esta reserved para este mismo customer). Sera al firmar
      // cuando bloqueemos si esta occupied/maintenance/blocked.

      // Código promocional: si es válido (percentage/fixed), calcula el
      // descuento recurrente y registra el uso. Tiene prioridad sobre un
      // `discountAmount` manual.
      let discountAmount = input.discountAmount;
      let discountReason = input.discountReason?.trim() || null;
      let promotionId: string | null = null;
      let freeMonthsRemaining = 0;
      if (input.promotionCode?.trim()) {
        const applied = await this.promotions.applyToContractTx(
          tx,
          tenantId,
          input.promotionCode,
          Number(input.priceMonthly),
        );
        discountAmount = applied.discountAmount;
        discountReason = applied.discountReason;
        promotionId = applied.promotionId;
        freeMonthsRemaining = applied.freeMonths;
      }

      // Seguro opcional: congela la prima del plan activo en el contrato.
      let insurancePlanId: string | null = null;
      let insurancePrice: number | null = null;
      if (input.insurancePlanId) {
        const plan = await tx.insurancePlan.findFirst({
          where: { id: input.insurancePlanId, tenantId, isActive: true },
          select: { id: true, monthlyPrice: true },
        });
        if (!plan) {
          throw new NotFoundException({
            code: 'insurance_plan_not_found',
            message: 'Plan de seguro no encontrado o inactivo',
          });
        }
        insurancePlanId = plan.id;
        insurancePrice = Number(plan.monthlyPrice);
      }

      const contractNumber = await this.nextContractNumber(tx, tenantId);
      return tx.contract.create({
        data: {
          tenantId,
          customerId: input.customerId,
          unitId: input.unitId,
          contractNumber,
          status: 'draft',
          startDate: new Date(input.startDate),
          ...(input.endDate ? { endDate: new Date(input.endDate) } : {}),
          billingCycle: input.billingCycle,
          priceMonthly: input.priceMonthly,
          discountAmount,
          discountReason,
          promotionId,
          freeMonthsRemaining,
          depositAmount: input.depositAmount,
          insurancePlanId,
          insurancePrice,
          autoRenew: input.autoRenew,
          cancellationNoticeDays: input.cancellationNoticeDays,
          notes: input.notes?.trim() || null,
          events: {
            create: {
              tenantId,
              eventType: 'created',
              payload: {
                contractNumber,
                unitId: input.unitId,
                customerId: input.customerId,
              },
              createdByUserId: args.userId,
            },
          },
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          insurancePlan: { select: { name: true } },
        },
      });
    }, tenantId);

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'contract.created',
      entityType: 'Contract',
      entityId: created.id,
      changes: {
        contractNumber: created.contractNumber,
        customerId: created.customerId,
        unitId: created.unitId,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    input: UpdateContractInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    // En estados activos solo permitimos cambios "meta" (notas, autoRenew,
    // endDate planificada, dias preaviso). El precio cambia via endpoint
    // dedicado para que sea auditeable.
    const data: Prisma.ContractUpdateInput = {};
    const changes: Record<string, unknown> = {};
    if (args.input.endDate !== undefined) {
      data.endDate = args.input.endDate ? new Date(args.input.endDate) : null;
      changes.endDate = args.input.endDate;
    }
    if (args.input.discountAmount !== undefined && existing.status === 'draft') {
      data.discountAmount = args.input.discountAmount;
      changes.discountAmount = args.input.discountAmount;
    }
    if (args.input.discountReason !== undefined && existing.status === 'draft') {
      data.discountReason = args.input.discountReason?.trim() || null;
      changes.discountReason = data.discountReason;
    }
    if (args.input.autoRenew !== undefined) {
      data.autoRenew = args.input.autoRenew;
      changes.autoRenew = args.input.autoRenew;
    }
    if (args.input.cancellationNoticeDays !== undefined) {
      data.cancellationNoticeDays = args.input.cancellationNoticeDays;
      changes.cancellationNoticeDays = args.input.cancellationNoticeDays;
    }
    if (args.input.notes !== undefined) {
      data.notes = args.input.notes?.trim() || null;
      changes.notes = data.notes;
    }

    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data,
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
              },
            },
            insurancePlan: { select: { name: true } },
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.updated',
      entityType: 'Contract',
      entityId: updated.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async sign(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
    /** Firma electrónica simple (remota, asistida o self-service). */
    signature?: {
      signerName: string;
      signerEmail?: string | null;
      method: 'drawn' | 'typed';
      signatureImage?: string | null;
      typedSignature?: string | null;
      channel?: string;
    };
    /**
     * Si true, NO se emite el acceso al firmar: queda diferido a que se pague la
     * 1ª factura (reserva online con pago obligatorio). Lo marca el booking.
     */
    deferAccessUntilPaid?: boolean;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'active');

    const updated = await this.prisma
      .withTenant(async (tx) => {
        // Anti-doble-ocupación: serializa por trastero con un advisory lock (se
        // libera al commit), igual que el booking público. Dos firmas concurrentes
        // sobre la misma unidad se ordenan; la 2ª ve la unidad ya `occupied` → 409.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${existing.unitId}::text))`;
        // Verificar que el unit este disponible. Permitimos reserved si la
        // reserva pertenece al mismo customer (la conversion de reserva
        // pasa por aqui despues de convertirla).
        const unit = await tx.unit.findUnique({ where: { id: existing.unitId } });
        if (!unit) {
          throw new NotFoundException({ code: 'unit_not_found', message: 'Unit perdida' });
        }
        if (unit.status !== 'available' && unit.status !== 'reserved') {
          throw new ConflictException({
            code: 'unit_not_available',
            message: `No se puede firmar: el trastero esta en estado ${unit.status}`,
          });
        }

        const signedAt = new Date();
        const row = await tx.contract.update({
          where: { id: args.contractId },
          data: {
            status: 'active',
            signedAt,
            // La firma consume el token remoto (si lo había).
            signingTokenHash: null,
            signingTokenExpiresAt: null,
            // Si el contrato lleva fianza, queda RETENIDA al activarse (se liquida
            // al finalizar vía settleDeposit). No pisa un estado ya avanzado.
            ...(Number(existing.depositAmount) > 0 && existing.depositStatus === 'none'
              ? { depositStatus: 'held' as const }
              : {}),
          },
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
              },
            },
            insurancePlan: { select: { name: true } },
          },
        });
        await tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'signed',
            payload: { signedAt: signedAt.toISOString() },
            createdByUserId: args.userId,
          },
        });
        await this.syncUnitStatus(
          tx,
          args,
          existing.unitId,
          unit.status as UnitStatus,
          'occupied',
          `Contrato ${row.contractNumber} firmado`,
        );

        // Registro probatorio de la firma electrónica simple.
        if (args.signature) {
          const termsText = buildContractTermsText({
            contractNumber: row.contractNumber,
            customerName:
              row.customer.customerType === 'business'
                ? (row.customer.companyName ?? '')
                : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' '),
            unitCode: row.unit.code,
            facilityName: row.unit.facility.name,
            priceMonthly: Number(row.priceMonthly),
            depositAmount: Number(row.depositAmount),
            billingCycle: row.billingCycle,
            startDate: row.startDate.toISOString().slice(0, 10),
          });
          const documentHash = createHash('sha256').update(termsText).digest('hex');
          await tx.contractSignature.create({
            data: {
              tenantId: args.tenantId,
              contractId: args.contractId,
              signerName: args.signature.signerName,
              signerEmail: args.signature.signerEmail ?? null,
              method: args.signature.method,
              signatureImage: args.signature.signatureImage ?? null,
              typedSignature: args.signature.typedSignature ?? null,
              documentHash,
              ipAddress: args.meta.ipAddress ?? null,
              userAgent: args.meta.userAgent ?? null,
              channel: args.signature.channel ?? 'remote',
            },
          });
        }
        return row;
      }, args.tenantId)
      .catch((err: unknown) => {
        // Índice único parcial `contracts_one_active_per_unit`: si (pese al lock)
        // se intentara activar un 2º contrato en la misma unidad → 409 claro.
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          throw new ConflictException({
            code: 'unit_not_available',
            message: 'El trastero ya tiene un contrato activo',
          });
        }
        throw err;
      });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.signed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { contractNumber: updated.contractNumber },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: updated.customerId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
            customerType: true,
          },
        }),
      args.tenantId,
    );
    const recipientName =
      customer?.customerType === 'business'
        ? (customer.companyName ?? 'Empresa')
        : [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || 'Cliente';
    const payload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'contract',
      entityId: updated.id,
      recipientEmail: customer?.email ?? null,
      recipientPhone: customer?.phone ?? null,
      customerId: updated.customerId,
      scope: {
        customer: {
          firstName: customer?.firstName ?? '',
          lastName: customer?.lastName ?? '',
          displayName: recipientName,
          email: customer?.email ?? '',
        },
        contract: {
          number: updated.contractNumber,
          priceMonthly: Number(updated.priceMonthly).toFixed(2),
          startDate: updated.startDate.toISOString().slice(0, 10),
          endDate: updated.endDate?.toISOString().slice(0, 10) ?? '',
        },
        unit: { code: updated.unit.code },
        facility: { name: updated.unit.facility.name },
        ...(args.deferAccessUntilPaid ? { deferAccess: true } : {}),
      },
    };
    this.eventBus.emit(DOMAIN_EVENTS.contract_signed, payload);
    return this.toDto(updated);
  }

  async requestEnd(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'ending');
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { status: 'ending', endingRequestedAt: new Date() },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          insurancePlan: { select: { name: true } },
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'ending_requested',
          payload: {},
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.ending_requested',
      entityType: 'Contract',
      entityId: updated.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  // -------------------------------------------------------------------------
  // Move-out self-service (portal del inquilino)
  // -------------------------------------------------------------------------

  private toPortalDto(row: {
    id: string;
    contractNumber: string;
    status: string;
    startDate: Date;
    endDate: Date | null;
    priceMonthly: unknown;
    discountAmount: unknown;
    cancellationNoticeDays: number;
    endingRequestedAt: Date | null;
    depositAmount: unknown;
    depositStatus: string;
    freeMonthsRemaining: number;
    insurancePlanId: string | null;
    insurancePrice: unknown;
    signedPdfUrl: string | null;
    unit: { code: string; facility: { name: string } };
    insurancePlan: { name: string } | null;
  }): PortalContractDto {
    const base = Number(row.priceMonthly);
    const discount = Number(row.discountAmount);
    return {
      id: row.id,
      contractNumber: row.contractNumber,
      unitCode: row.unit.code,
      facilityName: row.unit.facility.name,
      status: row.status as ContractStatusValue,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate?.toISOString().slice(0, 10) ?? null,
      priceMonthly: base,
      effectivePrice: this.pricing.computeEffectivePrice({ base, discount }),
      cancellationNoticeDays: row.cancellationNoticeDays,
      endingRequestedAt: row.endingRequestedAt?.toISOString() ?? null,
      depositAmount: Number(row.depositAmount),
      depositStatus: row.depositStatus as PortalContractDto['depositStatus'],
      discountAmount: discount,
      freeMonthsRemaining: row.freeMonthsRemaining,
      insurancePlanId: row.insurancePlanId,
      insurancePlanName: row.insurancePlan?.name ?? null,
      insurancePrice: row.insurancePrice != null ? Number(row.insurancePrice) : null,
      hasSignedPdf: !!row.signedPdfUrl,
    };
  }

  /** Contratos active/ending del inquilino (para el portal). */
  async listForCustomer(tenantId: string, customerId: string): Promise<PortalContractDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: { tenantId, customerId, deletedAt: null, status: { in: ['active', 'ending'] } },
          orderBy: { startDate: 'desc' },
          include: {
            unit: { select: { code: true, facility: { select: { name: true } } } },
            insurancePlan: { select: { name: true } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toPortalDto(r));
  }

  /**
   * El inquilino solicita la baja desde el portal: deja el contrato en `ending`
   * con la fecha de salida (respetando el preaviso) y emite el evento para que
   * el staff reciba la notificación y se dispare la encuesta de salida.
   */
  async requestEndByCustomer(args: {
    tenantId: string;
    customerId: string;
    contractId: string;
    facilityScope?: string[] | null;
    endDate: string;
  }): Promise<PortalContractDto> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: {
            id: args.contractId,
            customerId: args.customerId,
            tenantId: args.tenantId,
            deletedAt: null,
          },
        }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (existing.status !== 'active') {
      throw new BadRequestException({
        code: 'contract_not_active',
        message: 'Solo puedes solicitar la baja de un contrato activo',
      });
    }
    // Preaviso: la fecha de salida debe respetar `cancellationNoticeDays`.
    const minDate = new Date();
    minDate.setHours(0, 0, 0, 0);
    minDate.setDate(minDate.getDate() + existing.cancellationNoticeDays);
    const requested = new Date(`${args.endDate}T00:00:00Z`);
    if (requested.getTime() < minDate.getTime()) {
      throw new BadRequestException({
        code: 'notice_period_not_met',
        message: `La baja requiere un preaviso de ${existing.cancellationNoticeDays} días`,
        details: { minEndDate: minDate.toISOString().slice(0, 10) },
      });
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { status: 'ending', endDate: requested, endingRequestedAt: new Date() },
        include: {
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
          unit: { select: { code: true, facility: { select: { name: true } } } },
          insurancePlan: { select: { name: true } },
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'ending_requested',
          payload: { requestedEndDate: args.endDate, channel: 'portal' },
          createdByUserId: null,
        },
      });
      return row;
    }, args.tenantId);

    const c = updated.customer;
    const displayName =
      c.customerType === 'business'
        ? (c.companyName ?? 'Empresa')
        : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
    const payload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'contract',
      entityId: updated.id,
      recipientEmail: c.email ?? null,
      recipientPhone: c.phone ?? null,
      customerId: updated.customerId,
      scope: {
        customer: { firstName: c.firstName ?? '', displayName, email: c.email ?? '' },
        contract: { number: updated.contractNumber, endDate: args.endDate },
        unit: { code: updated.unit.code },
        facility: { name: updated.unit.facility.name },
      },
    };
    this.eventBus.emit(DOMAIN_EVENTS.contract_move_out_requested, payload);

    return this.toPortalDto(updated);
  }

  /**
   * El inquilino cancela una baja en curso (contrato en `ending`): vuelve a
   * `active`, limpiando la fecha de salida y la marca de solicitud.
   *
   * Es seguro porque en el estado `ending` todavía no ha ocurrido nada
   * irreversible (el cierre real —liberar la unidad, liquidar fianza— sucede en
   * `end`). Solo revierte contratos en `ending`; cualquier otro estado → 400.
   */
  async cancelMoveOutByCustomer(args: {
    tenantId: string;
    customerId: string;
    contractId: string;
  }): Promise<PortalContractDto> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: {
            id: args.contractId,
            customerId: args.customerId,
            tenantId: args.tenantId,
            deletedAt: null,
          },
        }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_ending',
        message: 'Solo puedes cancelar una baja que esté en curso',
      });
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { status: 'active', endDate: null, endingRequestedAt: null },
        include: {
          unit: { select: { code: true, facility: { select: { name: true } } } },
          insurancePlan: { select: { name: true } },
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'resumed',
          payload: { channel: 'portal', reason: 'move_out_cancelled' },
          createdByUserId: null,
        },
      });
      return row;
    }, args.tenantId);

    return this.toPortalDto(updated);
  }

  async end(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'ended');
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { status: 'ended', endedAt: new Date() },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          insurancePlan: { select: { name: true } },
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'ended',
          payload: {},
          createdByUserId: args.userId,
        },
      });
      // Liberar el unit -> available.
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
      if (unit.status === 'occupied') {
        await this.syncUnitStatus(
          tx,
          args,
          existing.unitId,
          unit.status,
          'available',
          `Contrato ${row.contractNumber} finalizado`,
        );
      }
      // Cancelar el dunning pendiente de las facturas de este contrato: un
      // contrato finalizado no debe seguir recibiendo recordatorios de impago
      // programados (la deuda real se gestiona por Cartera/overlock).
      await this.cancelScheduledDunning(tx, args.tenantId, args.contractId, 'Contrato finalizado');
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.ended',
      entityType: 'Contract',
      entityId: updated.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    await this.emitContractEnded(args.tenantId, updated);
    return this.toDto(updated);
  }

  /**
   * Emite `domain.contract_ended` tras finalizar/cancelar un contrato vivo. Lo
   * escuchan las automatizaciones de fin de contrato y `AccessIntegrationsService`
   * (revoca las credenciales de acceso si al inquilino no le queda ningún
   * contrato activo). Antes NO se emitía → PIN de acceso vivo tras la baja.
   */
  private async emitContractEnded(
    tenantId: string,
    contract: {
      id: string;
      customerId: string;
      contractNumber: string;
      priceMonthly: Prisma.Decimal;
      startDate: Date;
      endDate: Date | null;
      unitId: string;
      unit: { code: string; facility: { name: string } };
    },
  ): Promise<void> {
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findUnique({
          where: { id: contract.customerId },
          select: {
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
          },
        }),
      tenantId,
    );
    const displayName =
      customer?.companyName?.trim() ||
      `${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`.trim();
    const payload: DomainEventPayload = {
      tenantId,
      entityType: 'contract',
      entityId: contract.id,
      recipientEmail: customer?.email ?? null,
      recipientPhone: customer?.phone ?? null,
      customerId: contract.customerId,
      scope: {
        customer: {
          firstName: customer?.firstName ?? '',
          lastName: customer?.lastName ?? '',
          displayName,
          email: customer?.email ?? '',
        },
        contract: {
          number: contract.contractNumber,
          priceMonthly: Number(contract.priceMonthly).toFixed(2),
          startDate: contract.startDate.toISOString().slice(0, 10),
          endDate: contract.endDate?.toISOString().slice(0, 10) ?? '',
        },
        unit: { code: contract.unit.code },
        facility: { name: contract.unit.facility.name },
      },
    };
    this.eventBus.emit(DOMAIN_EVENTS.contract_ended, payload);
    // El trastero queda libre → avisar a la lista de espera de su tipo.
    this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
      tenantId,
      unitId: contract.unitId,
    } satisfies UnitAvailablePayload);
  }

  /**
   * Cancela las acciones de dunning aún `scheduled` de las facturas de un
   * contrato al finalizarlo/cancelarlo → un contrato dado de baja no sigue
   * recibiendo recordatorios de impago programados (la deuda real se gestiona
   * por Cartera/overlock). No toca las ya `executed`/`failed` (rastro histórico).
   */
  private async cancelScheduledDunning(
    tx: Prisma.TransactionClient,
    tenantId: string,
    contractId: string,
    notes: string,
  ): Promise<void> {
    const invoices = await tx.invoice.findMany({
      where: { contractId, deletedAt: null },
      select: { id: true },
    });
    if (invoices.length === 0) return;
    await tx.dunningAction.updateMany({
      where: {
        tenantId,
        invoiceId: { in: invoices.map((i) => i.id) },
        status: 'scheduled',
      },
      data: { status: 'cancelled', notes },
    });
  }

  /**
   * Liquida la fianza retenida al finalizar el contrato: devuelve total o
   * parcialmente el depósito, reteniendo el resto por daños/deuda (con motivo).
   * Transiciona `depositStatus` held → returned/partially_returned. La devolución
   * NO es una factura (la fianza es una garantía sin IVA); se registra en el
   * contrato + timeline + audit. El operador decide cuánto devolver (viendo la
   * deuda pendiente en la UI). Reutiliza el evento `note_added` con payload
   * tipado (el enum no tiene `deposit_settled`, patrón del proyecto).
   */
  async settleDeposit(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: SettleDepositInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.depositStatus !== 'held') {
      throw new BadRequestException({
        code: 'deposit_not_held',
        message: 'La fianza no está retenida (nada que liquidar)',
      });
    }
    const deposit = Number(existing.depositAmount);
    const returned = args.input.returnedAmount;
    if (returned < 0 || isGreaterThan(returned, deposit)) {
      throw new BadRequestException({
        code: 'invalid_return_amount',
        message: `El importe a devolver debe estar entre 0 y ${deposit.toFixed(2)} €`,
      });
    }
    const retained = subtractAmounts(deposit, returned);
    const fullyReturned = isAtLeast(returned, deposit);
    const newStatus: 'returned' | 'partially_returned' = fullyReturned
      ? 'returned'
      : 'partially_returned';
    // Si se retiene algo, el motivo es obligatorio (trazabilidad legal).
    if (isGreaterThan(retained, 0) && !args.input.retentionReason?.trim()) {
      throw new BadRequestException({
        code: 'retention_reason_required',
        message: 'Indica el motivo de la retención (daños, deuda pendiente, …)',
      });
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          depositStatus: newStatus,
          depositReturnedAmount: returned,
          depositSettledAt: new Date(),
          depositRetentionReason: isGreaterThan(retained, 0)
            ? (args.input.retentionReason?.trim() ?? null)
            : null,
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          insurancePlan: { select: { name: true } },
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'note_added',
          payload: {
            event: 'deposit_settled',
            deposit,
            returned,
            retained,
            retentionReason: args.input.retentionReason?.trim() ?? null,
          },
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.deposit_settled',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { deposit, returned, retained, status: newStatus },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async cancel(args: {
    tenantId: string;
    /** `null` cuando lo lanza un proceso automático (cron de bookings impagados). */
    userId: string | null;
    contractId: string;
    facilityScope?: string[] | null;
    input: CancelContractInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'cancelled');
    // Cancelar un contrato VIVO (no un draft) equivale a una baja: hay que
    // revocar accesos y disparar las automatizaciones de fin de contrato.
    const wasLive = existing.status === 'active' || existing.status === 'ending';
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { status: 'cancelled', cancelledAt: new Date() },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          insurancePlan: { select: { name: true } },
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'cancelled',
          payload: { reason: args.input.reason?.trim() || null },
          createdByUserId: args.userId,
        },
      });
      // Si el contrato estaba activo, liberar el unit.
      // Libera la unidad si estaba ocupada (contrato firmado) o RESERVADA (hold
      // de un booking self-service que se cancela sin firmar, p. ej. por impago
      // vía BookingExpiryCron). Sin liberar el `reserved`, la unidad quedaría
      // retenida para siempre.
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
      const releasable =
        unit.status === 'reserved' ||
        ((existing.status === 'active' || existing.status === 'ending') &&
          unit.status === 'occupied');
      if (releasable) {
        await this.syncUnitStatus(
          tx,
          args,
          existing.unitId,
          unit.status,
          'available',
          `Contrato ${row.contractNumber} cancelado`,
        );
      }
      // Cancelar el dunning pendiente de las facturas de este contrato (ver end()).
      await this.cancelScheduledDunning(tx, args.tenantId, args.contractId, 'Contrato cancelado');
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.cancelled',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    if (wasLive) await this.emitContractEnded(args.tenantId, updated);
    return this.toDto(updated);
  }

  async changePrice(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    input: ChangeContractPriceInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status !== 'active' && existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_active',
        message: 'Solo se puede cambiar el precio en contratos activos',
      });
    }
    const previousPrice = Number(existing.priceMonthly);
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { priceMonthly: args.input.priceMonthly },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          insurancePlan: { select: { name: true } },
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'price_changed',
          payload: {
            from: previousPrice,
            to: args.input.priceMonthly,
            reason: args.input.reason,
          },
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.price_changed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: {
        from: previousPrice,
        to: args.input.priceMonthly,
        reason: args.input.reason,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /** Include estándar para hidratar un `ContractDto` (customer + unit + seguro). */
  private contractInclude() {
    return {
      customer: {
        select: {
          firstName: true,
          lastName: true,
          companyName: true,
          customerType: true,
        },
      },
      unit: {
        select: {
          code: true,
          facilityId: true,
          facility: { select: { name: true } },
        },
      },
      insurancePlan: { select: { name: true } },
    } satisfies Prisma.ContractInclude;
  }

  /** Suma N meses a una fecha, conservando el fin de mes (evita desbordes de día). */
  private addMonths(date: Date, months: number): Date {
    const d = new Date(date);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
  }

  /**
   * Renueva un contrato: extiende su `endDate` N meses (desde el fin actual o
   * desde hoy si es indefinido). Si estaba `ending`, vuelve a `active` y limpia
   * la solicitud de baja. Palanca de retención (la página /renewals lo usa).
   */
  async renew(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    months: number;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status !== 'active' && existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_renewable',
        message: 'Solo se pueden renovar contratos activos o en baja',
      });
    }
    const base =
      existing.endDate && existing.endDate.getTime() > Date.now() ? existing.endDate : new Date();
    const newEndDate = this.addMonths(base, args.months);
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          endDate: newEndDate,
          // Renovar reactiva un contrato en baja y limpia la solicitud.
          ...(existing.status === 'ending'
            ? { status: 'active' as const, endingRequestedAt: null }
            : {}),
          endingSoonNotifiedAt: null,
        },
        include: this.contractInclude(),
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'note_added',
          payload: { event: 'renewed', months: args.months, newEndDate: newEndDate.toISOString() },
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.renewed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { months: args.months, newEndDate: newEndDate.toISOString().slice(0, 10) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Traslado de trastero: reasigna la unidad de un contrato activo a otra
   * disponible (upsell/downsize). Libera la unidad vieja (→available), ocupa la
   * nueva (→occupied) y opcionalmente cambia la cuota. La próxima factura
   * recurrente ya sale con la unidad/precio nuevos. (Prorrateo de una factura de
   * ajuste = follow-up; hoy no se genera factura intermedia.)
   */
  async changeUnit(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    newUnitId: string;
    newPrice?: number;
    prorate?: boolean;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status !== 'active' && existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_active',
        message: 'Solo se puede trasladar un contrato activo',
      });
    }
    const oldPrice = Number(existing.priceMonthly);
    if (args.newUnitId === existing.unitId) {
      throw new BadRequestException({
        code: 'same_unit',
        message: 'El trastero de destino es el mismo',
      });
    }
    const oldUnitId = existing.unitId;
    const updated = await this.prisma
      .withTenant(async (tx) => {
        // Anti-doble-ocupación: serializa por el trastero de DESTINO (dos traslados
        // o un traslado + una firma sobre la misma unidad no se pisan).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${args.newUnitId}::text))`;
        const newUnit = await tx.unit.findFirst({ where: { id: args.newUnitId } });
        if (!newUnit) {
          throw new NotFoundException({
            code: 'unit_not_found',
            message: 'Trastero no encontrado',
          });
        }
        // El scope aplica también al trastero de DESTINO.
        assertFacilityAllowed(args.facilityScope, newUnit.facilityId);
        if (newUnit.status !== 'available') {
          throw new BadRequestException({
            code: 'unit_not_available',
            message: 'El trastero de destino no está disponible',
          });
        }
        const ctx = { tenantId: args.tenantId, userId: args.userId, meta: args.meta };
        // Libera la vieja, ocupa la nueva.
        const oldUnit = await tx.unit.findUniqueOrThrow({ where: { id: oldUnitId } });
        if (oldUnit.status === 'occupied' || oldUnit.status === 'reserved') {
          await this.syncUnitStatus(
            tx,
            ctx,
            oldUnitId,
            oldUnit.status,
            'available',
            'Traslado: origen liberado',
          );
        }
        await this.syncUnitStatus(
          tx,
          ctx,
          args.newUnitId,
          newUnit.status,
          'occupied',
          'Traslado: destino ocupado',
        );
        const row = await tx.contract.update({
          where: { id: args.contractId },
          data: {
            unitId: args.newUnitId,
            ...(args.newPrice != null ? { priceMonthly: args.newPrice } : {}),
          },
          include: this.contractInclude(),
        });
        await tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'unit_changed',
            payload: {
              fromUnitId: oldUnitId,
              toUnitId: args.newUnitId,
              toUnitCode: newUnit.code,
              ...(args.newPrice != null ? { newPrice: args.newPrice } : {}),
            },
            createdByUserId: args.userId,
          },
        });
        return row;
      }, args.tenantId)
      .catch((err: unknown) => {
        // Índice único parcial: si (pese al lock) se intentara ocupar una unidad
        // que ya tiene un contrato activo → 409 claro.
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          throw new ConflictException({
            code: 'unit_not_available',
            message: 'El trastero de destino ya tiene un contrato activo',
          });
        }
        throw err;
      });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.unit_changed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { fromUnitId: oldUnitId, toUnitId: args.newUnitId, newPrice: args.newPrice ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    // Prorrateo del ajuste: si el traslado sube la cuota y se pidió prorate,
    // se emite una factura por la DIFERENCIA prorrateada por los días que restan
    // del mes natural (el resto del mes ya se pagó al precio viejo). Si baja o
    // no cambia, no se factura (el ahorro llega en la próxima recurrente).
    if (args.prorate && args.newPrice != null && existing.customerId) {
      const newPrice = args.newPrice;
      if (isGreaterThan(newPrice, oldPrice)) {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const remainingDays = daysInMonth - now.getUTCDate() + 1; // incluye hoy
        const diff = subtractAmounts(newPrice, oldPrice);
        const adjustment = Math.round((toCents(diff) * remainingDays) / daysInMonth) / 100;
        if (adjustment > 0) {
          try {
            const draft = await this.invoices.create({
              tenantId: args.tenantId,
              userId: args.userId,
              meta: args.meta,
              input: {
                invoiceType: 'F1',
                customerId: existing.customerId,
                contractId: args.contractId,
                items: [
                  {
                    description: `Ajuste por cambio de trastero (${remainingDays} días)`,
                    quantity: 1,
                    unitPrice: adjustment,
                    taxRate: 21,
                  },
                ],
                verifactuMode: 'verifactu',
              },
            });
            await this.invoices.issue({
              tenantId: args.tenantId,
              userId: args.userId,
              invoiceId: draft.id,
              meta: args.meta,
            });
          } catch (err) {
            // Best-effort: el traslado ya está hecho; si la factura falla (p. ej.
            // sin serie por defecto) queda registrado y no se bloquea el traslado.
            this.logger.warn(
              `changeUnit: no se pudo emitir la factura de ajuste del contrato ${args.contractId}: ${String(err)}`,
            );
          }
        }
      }
    }

    return this.toDto(updated);
  }

  /** Asigna o quita (planId null) el seguro de un contrato; congela la prima. */
  /**
   * Gating por plan: asignar un seguro requiere la feature `insurance`. Se
   * comprueba en el service (no en el controller) porque solo aplica al
   * ASIGNAR un plan, no al quitarlo — un tenant que perdió la feature
   * (downgrade) debe poder seguir retirando un seguro ya asignado.
   */
  private async assertInsuranceFeature(tenantId: string): Promise<void> {
    const sub = await this.prisma.withTenant(
      (tx) =>
        tx.tenantSubscription.findUnique({
          where: { tenantId },
          include: { plan: { select: { slug: true, tenantFeatures: true } } },
        }),
      tenantId,
    );
    if (!(sub ? resolvePlanFeatures(sub.plan) : []).includes('insurance')) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'El seguro de contenido no está incluido en tu plan',
        details: { requiredFeature: 'insurance' },
      });
    }
  }

  async setInsurance(args: {
    tenantId: string;
    contractId: string;
    facilityScope?: string[] | null;
    planId: string | null;
  }): Promise<ContractDto> {
    await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (args.planId) await this.assertInsuranceFeature(args.tenantId);
    let insurancePlanId: string | null = null;
    let insurancePrice: number | null = null;
    if (args.planId) {
      const plan = await this.prisma.withTenant(
        (tx) =>
          tx.insurancePlan.findFirst({
            where: { id: args.planId!, tenantId: args.tenantId, isActive: true },
            select: { id: true, monthlyPrice: true },
          }),
        args.tenantId,
      );
      if (!plan) {
        throw new NotFoundException({
          code: 'insurance_plan_not_found',
          message: 'Plan de seguro no encontrado o inactivo',
        });
      }
      insurancePlanId = plan.id;
      insurancePrice = Number(plan.monthlyPrice);
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: { insurancePlanId, insurancePrice },
          include: {
            customer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            unit: {
              select: { code: true, facilityId: true, facility: { select: { name: true } } },
            },
            insurancePlan: { select: { name: true } },
          },
        }),
      args.tenantId,
    );
    return this.toDto(updated);
  }

  async addNote(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    input: AddContractNoteInput;
    meta: RequestMeta;
  }): Promise<ContractEventDto> {
    await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'note_added',
            payload: { note: args.input.note.trim() },
            createdByUserId: args.userId,
          },
          include: { createdBy: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.note_added',
      entityType: 'Contract',
      entityId: args.contractId,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return {
      id: row.id,
      eventType: row.eventType,
      payload: (row.payload as Record<string, unknown>) ?? {},
      createdByUserId: row.createdByUserId,
      createdByName: row.createdBy?.fullName ?? null,
      occurredAt: row.occurredAt.toISOString(),
    };
  }

  /**
   * Setea el `signed_pdf_url` y emite audit. Lo llama ContractPdfService
   * tras subir el PDF a MinIO.
   */
  async attachSignedPdf(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    pdfUrl: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: { signedPdfUrl: args.pdfUrl },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.pdf_generated',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { pdfUrl: args.pdfUrl },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /**
   * Crea un contrato a partir de una reserva confirmada. Lo invoca
   * ReservationsService.convertToContract dentro de su transaccion.
   */
  async createFromReservation(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      userId: string;
      reservationId: string;
      customerId: string;
      unitId: string;
      startDate: string;
      endDate?: string;
      priceMonthly: number;
      discountAmount: number;
      discountReason?: string;
      depositAmount: number;
      billingCycle: 'monthly' | 'weekly' | 'daily';
    },
  ): Promise<Contract> {
    const contractNumber = await this.nextContractNumber(tx, args.tenantId);
    const created = await tx.contract.create({
      data: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        unitId: args.unitId,
        contractNumber,
        status: 'draft',
        startDate: new Date(args.startDate),
        ...(args.endDate ? { endDate: new Date(args.endDate) } : {}),
        billingCycle: args.billingCycle,
        priceMonthly: args.priceMonthly,
        discountAmount: args.discountAmount,
        discountReason: args.discountReason?.trim() || null,
        depositAmount: args.depositAmount,
        events: {
          create: {
            tenantId: args.tenantId,
            eventType: 'created',
            payload: {
              contractNumber,
              fromReservationId: args.reservationId,
            },
            createdByUserId: args.userId,
          },
        },
      },
    });
    return created;
  }

  private async findOrThrow(
    tenantId: string,
    contractId: string,
    facilityScope?: string[] | null,
  ): Promise<ContractWithRelations> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: { id: contractId, deletedAt: null },
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
              },
            },
            insurancePlan: { select: { name: true } },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    assertFacilityAllowed(facilityScope, row.unit.facilityId);
    return row;
  }

  private assertTransition(from: ContractStatus, to: ContractStatusValue): void {
    const allowed = ALLOWED_TRANSITIONS[from as ContractStatusValue];
    if (!allowed.includes(to)) {
      throw new BadRequestException({
        code: 'invalid_contract_transition',
        message: `Transicion invalida: ${from} -> ${to}`,
      });
    }
  }

  /**
   * Sincroniza el `units.status` cuando un contrato cambia de estado.
   * Actualiza el unit directamente y graba `unit_status_history`. Bypasea
   * la regla "occupied solo via contract" del UnitsService porque ESTE
   * es el flujo de contrato.
   */
  private async syncUnitStatus(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; userId: string | null; meta: RequestMeta },
    unitId: string,
    from: UnitStatus,
    to: UnitStatus,
    reason: string,
  ): Promise<void> {
    if (from === to) return;
    await tx.unit.update({
      where: { id: unitId },
      data: { status: to },
    });
    await tx.unitStatusHistory.create({
      data: {
        tenantId: ctx.tenantId,
        unitId,
        previousStatus: from,
        newStatus: to,
        changedByUserId: ctx.userId,
        reason,
      },
    });
  }

  private async nextContractNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    // Patron simple: prefijo CT- + zero-padded count + año. Para Fase 4
    // (Verifactu) habra invoice_series por tenant; aqui no.
    const year = new Date().getFullYear();
    const prefix = `CT-${year}-`;
    const last = await tx.contract.findFirst({
      where: { tenantId, contractNumber: { startsWith: prefix } },
      orderBy: { contractNumber: 'desc' },
      select: { contractNumber: true },
    });
    let next = 1;
    if (last) {
      const tail = last.contractNumber.slice(prefix.length);
      const n = Number.parseInt(tail, 10);
      if (Number.isFinite(n)) next = n + 1;
    }
    return `${prefix}${String(next).padStart(5, '0')}`;
  }

  private toDto(row: ContractWithRelations): ContractDto {
    const customerName =
      row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre';
    const base = Number(row.priceMonthly);
    const discount = Number(row.discountAmount);
    return {
      id: row.id,
      contractNumber: row.contractNumber,
      customerId: row.customerId,
      customerName,
      unitId: row.unitId,
      unitCode: row.unit.code,
      facilityId: row.unit.facilityId,
      facilityName: row.unit.facility.name,
      status: row.status as ContractStatusValue,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
      signedAt: row.signedAt ? row.signedAt.toISOString() : null,
      endingRequestedAt: row.endingRequestedAt ? row.endingRequestedAt.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      billingCycle: row.billingCycle,
      priceMonthly: base,
      discountAmount: discount,
      discountReason: row.discountReason,
      discountExpiresAt: row.discountExpiresAt ? row.discountExpiresAt.toISOString() : null,
      effectivePrice: this.pricing.computeEffectivePrice({ base, discount }),
      freeMonthsRemaining: row.freeMonthsRemaining,
      depositAmount: Number(row.depositAmount),
      depositStatus: row.depositStatus,
      depositReturnedAmount: Number(row.depositReturnedAmount),
      depositSettledAt: row.depositSettledAt ? row.depositSettledAt.toISOString() : null,
      depositRetentionReason: row.depositRetentionReason,
      signedPdfUrl: row.signedPdfUrl,
      insurancePlanId: row.insurancePlanId,
      insurancePlanName: row.insurancePlan?.name ?? null,
      insurancePrice: row.insurancePrice != null ? Number(row.insurancePrice) : null,
      autoRenew: row.autoRenew,
      cancellationNoticeDays: row.cancellationNoticeDays,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
