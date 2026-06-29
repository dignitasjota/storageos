import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { featuresForPlan } from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';

import { buildContractTermsText } from './contract-terms';
import { PricingService } from './pricing.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DomainEventPayload } from '../automations/domain-events';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly eventBus: EventEmitter2,
    private readonly promotions: PromotionsService,
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

    const updated = await this.prisma.withTenant(async (tx) => {
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
    }, args.tenantId);

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
    return this.toDto(updated);
  }

  async cancel(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    input: CancelContractInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'cancelled');
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
      if (existing.status === 'active' || existing.status === 'ending') {
        const unit = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
        if (unit.status === 'occupied') {
          await this.syncUnitStatus(
            tx,
            args,
            existing.unitId,
            unit.status,
            'available',
            `Contrato ${row.contractNumber} cancelado`,
          );
        }
      }
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
          include: { plan: { select: { slug: true } } },
        }),
      tenantId,
    );
    if (!featuresForPlan(sub?.plan.slug ?? '').includes('insurance')) {
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
      effectivePrice: this.pricing.computeEffectivePrice({ base, discount }),
      freeMonthsRemaining: row.freeMonthsRemaining,
      depositAmount: Number(row.depositAmount),
      depositStatus: row.depositStatus,
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
