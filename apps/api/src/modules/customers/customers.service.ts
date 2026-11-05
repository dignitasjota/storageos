import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isValidSpanishTaxId, normalizeTaxId } from '@storageos/shared';

import { customerScopeWhere } from '../../common/customer-scope';
import { subtractAmounts } from '../../common/money';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { EmailSuppressionsService } from '../email/email-suppressions.service';
import { ReferralsService } from '../referrals/referrals.service';

import type { FacilityScope } from '../../common/facility-scope';
import type { RequestMeta } from '../auth/auth.service';
import type { DomainEventPayload } from '../automations/domain-events';
import type { Customer, Prisma } from '@storageos/database';
import type {
  CreateCustomerInput,
  CustomerDto,
  CustomerDuplicateDto,
  EmailSuppressionDto,
  SetKycVerifiedInput,
  UpdateCustomerInput,
} from '@storageos/shared';

/** Lo vivo del inquilino: contratos en marcha y reservas pendientes. */
const CUSTOMER_COUNTS = {
  _count: {
    select: {
      contracts: { where: { status: { in: ['active', 'ending'] }, deletedAt: null } },
      reservations: { where: { status: { in: ['pending', 'confirmed'] } } },
    },
  },
} satisfies Prisma.CustomerInclude;

/** Tipos de documento que se comprueban (un pasaporte no tiene letra de control). */
const SPANISH_DOCUMENTS = ['dni', 'nie', 'nif', 'cif'];

type CustomerWithCounts = Customer & {
  _count?: { contracts: number; reservations: number };
};

function displayName(c: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'>) {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

interface ListFilters {
  search?: string;
  includeDeleted?: boolean;
  page?: PageRequest;
  facilityScope?: FacilityScope;
}

/** DNI, NIE o CIF normalizado; 400 si no es válido. El resto, tal cual. */
function checkedDocument(type: string | null | undefined, number: string | null | undefined) {
  const value = number?.trim();
  if (!value || !SPANISH_DOCUMENTS.includes((type ?? '').trim().toLowerCase())) return value;
  if (!isValidSpanishTaxId(value)) {
    throw new BadRequestException({
      code: 'invalid_tax_id',
      message: 'El DNI, NIE o CIF no es válido. Revisa la letra y los números.',
    });
  }
  return normalizeTaxId(value);
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly referrals: ReferralsService,
    private readonly suppressions: EmailSuppressionsService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<CustomerDto[]> {
    const where: Prisma.CustomerWhereInput = { ...customerScopeWhere(filters.facilityScope) };
    if (!filters.includeDeleted) where.deletedAt = null;
    if (filters.search) {
      // Por palabras: «Juan García» encuentra a quien tiene «Juan» en un campo y
      // «García» en otro (nombre y apellidos van en columnas distintas).
      const words = filters.search.trim().split(/\s+/).filter(Boolean).slice(0, 5);
      where.AND = words.map((q) => ({
        OR: [
          { firstName: { contains: q, mode: 'insensitive' as const } },
          { lastName: { contains: q, mode: 'insensitive' as const } },
          { companyName: { contains: q, mode: 'insensitive' as const } },
          { email: { contains: q, mode: 'insensitive' as const } },
          { phone: { contains: q, mode: 'insensitive' as const } },
          { documentNumber: { contains: q, mode: 'insensitive' as const } },
        ],
      }));
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          ...pageArgs(filters.page),
          include: CUSTOMER_COUNTS,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, customerId: string): Promise<CustomerDto> {
    const row = await this.findOrThrow(tenantId, customerId);
    return this.toDto(row);
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateCustomerInput;
    meta: RequestMeta;
  }): Promise<CustomerDto> {
    const data: Prisma.CustomerUncheckedCreateInput = {
      tenantId: args.tenantId,
      customerType: args.input.customerType,
      firstName: args.input.firstName?.trim() || null,
      lastName: args.input.lastName?.trim() || null,
      companyName: args.input.companyName?.trim() || null,
      documentType: args.input.documentType?.trim() || null,
      documentNumber: checkedDocument(args.input.documentType, args.input.documentNumber) || null,
      email: args.input.email?.trim() || null,
      phone: args.input.phone?.trim() || null,
      address: args.input.address?.trim() || null,
      city: args.input.city?.trim() || null,
      postalCode: args.input.postalCode?.trim() || null,
      country: args.input.country,
      emergencyContactName: args.input.emergencyContactName?.trim() || null,
      emergencyContactPhone: args.input.emergencyContactPhone?.trim() || null,
      billingEmail: args.input.billingEmail?.trim() || null,
      notes: args.input.notes?.trim() || null,
      tags: args.input.tags,
      depositExempt: args.input.depositExempt ?? false,
    };
    const created = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.create({
        data,
        include: CUSTOMER_COUNTS,
      });
      if (args.input.referralCode) {
        await this.referrals.registerInTx(tx, args.tenantId, args.input.referralCode, customer.id);
      }
      return customer;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.created',
      entityType: 'Customer',
      entityId: created.id,
      changes: { displayName: displayName(created) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    const payload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'customer',
      entityId: created.id,
      recipientEmail: created.email ?? null,
      recipientPhone: created.phone ?? null,
      customerId: created.id,
      scope: {
        customer: {
          firstName: created.firstName ?? '',
          lastName: created.lastName ?? '',
          displayName: displayName(created),
          email: created.email ?? '',
          phone: created.phone ?? '',
        },
      },
    };
    this.events.emit(DOMAIN_EVENTS.customer_created, payload);
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: UpdateCustomerInput;
    meta: RequestMeta;
  }): Promise<CustomerDto> {
    const existing = await this.findOrThrow(args.tenantId, args.customerId);
    const merged = { ...existing, ...args.input };
    const missingName =
      merged.customerType === 'business'
        ? !merged.companyName?.trim()
        : !merged.firstName?.trim() || !merged.lastName?.trim();
    if (missingName) {
      throw new BadRequestException({
        code: 'customer_name_required',
        message: 'Los particulares necesitan nombre y apellidos; las empresas, la razón social',
      });
    }
    const input = { ...args.input };
    if (input.documentNumber !== undefined || input.documentType !== undefined) {
      const document = checkedDocument(merged.documentType, merged.documentNumber);
      if (input.documentNumber !== undefined) input.documentNumber = document ?? '';
    }
    const data: Prisma.CustomerUpdateInput = {};
    const changes: Record<string, unknown> = {};
    const set = <K extends keyof UpdateCustomerInput>(key: K) => {
      const value = input[key];
      if (value === undefined) return;
      const cleaned = typeof value === 'string' && (value as string).trim() === '' ? null : value;
      (data as Record<string, unknown>)[key] = cleaned;
      changes[key] = cleaned;
    };
    set('customerType');
    set('firstName');
    set('lastName');
    set('companyName');
    set('documentType');
    set('documentNumber');
    set('email');
    set('phone');
    set('address');
    set('city');
    set('postalCode');
    set('country');
    set('emergencyContactName');
    set('emergencyContactPhone');
    set('billingEmail');
    set('notes');
    if (args.input.depositExempt !== undefined) {
      data.depositExempt = args.input.depositExempt;
      changes.depositExempt = args.input.depositExempt;
    }
    if (args.input.tags !== undefined) {
      data.tags = args.input.tags;
      changes.tags = args.input.tags;
    }

    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.customer.update({
          where: { id: args.customerId },
          data,
          include: CUSTOMER_COUNTS,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.updated',
      entityType: 'Customer',
      entityId: updated.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async softDelete(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    /** Ya sabe que debe dinero y quiere borrarlo igual. */
    confirmDebt?: boolean;
    meta: RequestMeta;
  }): Promise<void> {
    const existing = await this.findOrThrow(args.tenantId, args.customerId);
    // Con contratos vivos seguiría facturando y ocupando el trastero sin ficha.
    const live = await this.prisma.withTenant(
      (tx) =>
        tx.contract.count({
          where: {
            customerId: args.customerId,
            status: { in: ['draft', 'active', 'ending'] },
            deletedAt: null,
          },
        }),
      args.tenantId,
    );
    if (live > 0) {
      throw new ConflictException({
        code: 'customer_has_live_contracts',
        message: `Tiene ${live} contrato(s) sin cerrar: finalízalos o cancélalos antes de borrarlo.`,
      });
    }
    const [reservations, waiting, debt] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.reservation.count({
            where: { customerId: args.customerId, status: { in: ['pending', 'confirmed'] } },
          }),
          tx.waitlistEntry.count({
            where: { customerId: args.customerId, status: { in: ['waiting', 'notified'] } },
          }),
          tx.invoice.aggregate({
            where: {
              customerId: args.customerId,
              status: { in: ['issued', 'overdue'] },
              deletedAt: null,
            },
            _sum: { total: true, amountPaid: true },
          }),
        ]),
      args.tenantId,
    );
    if (reservations + waiting > 0) {
      throw new ConflictException({
        code: 'customer_has_reservations',
        message: 'Tiene una reserva o está en lista de espera: cancélalas antes de borrarlo.',
      });
    }
    const pending = subtractAmounts(
      Number(debt._sum.total ?? 0),
      Number(debt._sum.amountPaid ?? 0),
    );
    if (pending > 0 && !args.confirmDebt) {
      throw new ConflictException({
        code: 'customer_has_debt',
        message: 'Tiene facturas pendientes de cobro.',
        details: { amount: pending },
      });
    }
    // Sin contratos vivos: el borrado es lógico y conserva el historial.
    await this.prisma.withTenant(
      (tx) =>
        tx.customer.update({
          where: { id: args.customerId },
          data: { deletedAt: new Date() },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.deleted',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { displayName: displayName(existing) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  async setKycVerified(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: SetKycVerifiedInput;
    meta: RequestMeta;
  }): Promise<CustomerDto> {
    await this.findOrThrow(args.tenantId, args.customerId);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.customer.update({
          where: { id: args.customerId },
          data: {
            kycVerified: args.input.verified,
            kycVerifiedAt: args.input.verified ? new Date() : null,
          },
          include: CUSTOMER_COUNTS,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.input.verified ? 'customer.kyc_verified' : 'customer.kyc_revoked',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { notes: args.input.notes ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Comunicaciones comerciales del cliente. `subscribed: false` = se da de baja
   * (p. ej. lo pide por teléfono); `true` = vuelve a recibirlas (solo si lo pide).
   */
  async setMarketing(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    subscribed: boolean;
    meta: RequestMeta;
  }): Promise<CustomerDto> {
    await this.findOrThrow(args.tenantId, args.customerId);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.customer.update({
          where: { id: args.customerId },
          data: { marketingOptOutAt: args.subscribed ? null : new Date() },
          include: CUSTOMER_COUNTS,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.subscribed ? 'customer.marketing_resubscribed' : 'customer.marketing_opted_out',
      entityType: 'Customer',
      entityId: args.customerId,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Inquilinos con el mismo email, teléfono o documento. Solo avisa: un email
   * compartido en una familia es legítimo.
   */
  async duplicates(
    tenantId: string,
    q: { email?: string; phone?: string; documentNumber?: string; excludeId?: string },
    facilityScope?: FacilityScope,
  ): Promise<CustomerDuplicateDto[]> {
    const email = q.email?.trim().toLowerCase();
    const document = q.documentNumber?.trim().toUpperCase().replace(/[\s-]/g, '');
    const phone = q.phone?.replace(/\D/g, '').slice(-9);
    const usablePhone = phone && phone.length === 9 ? phone : null;
    if (!email && !document && !usablePhone) return [];
    return this.prisma.withTenant(async (tx) => {
      const byPhone = usablePhone
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM customers
            WHERE deleted_at IS NULL
              AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9) = ${usablePhone}`
        : [];
      const rows = await tx.customer.findMany({
        where: {
          deletedAt: null,
          ...(q.excludeId ? { id: { not: q.excludeId } } : {}),
          AND: [
            customerScopeWhere(facilityScope),
            {
              OR: [
                ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
                ...(document
                  ? [{ documentNumber: { equals: document, mode: 'insensitive' as const } }]
                  : []),
                ...(byPhone.length ? [{ id: { in: byPhone.map((r) => r.id) } }] : []),
              ],
            },
          ],
        },
        take: 5,
        select: {
          id: true,
          customerType: true,
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
          phone: true,
          documentNumber: true,
        },
      });
      const phoneIds = new Set(byPhone.map((r) => r.id));
      return rows.map((r) => ({
        id: r.id,
        displayName: displayName(r),
        matches: [
          ...(email && r.email?.toLowerCase() === email ? (['email'] as const) : []),
          ...(phoneIds.has(r.id) ? (['phone'] as const) : []),
          ...(document && r.documentNumber?.toUpperCase() === document
            ? (['document'] as const)
            : []),
        ],
      }));
    }, tenantId);
  }

  /** Bloqueos de correo que afectan al email del inquilino (rebote, spam). */
  async emailStatus(tenantId: string, customerId: string): Promise<EmailSuppressionDto[]> {
    const c = await this.findOrThrow(tenantId, customerId);
    if (!c.email) return [];
    return this.suppressions.forTenantEmail(tenantId, c.email);
  }

  /**
   * Desbloquea el email del inquilino (el buzón vuelve a funcionar o fue un
   * error). La baja comercial, si la pidió, se mantiene: se cambia aparte.
   */
  async clearEmailBlock(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    meta: RequestMeta;
  }): Promise<{ removed: number }> {
    const c = await this.findOrThrow(args.tenantId, args.customerId);
    if (!c.email) return { removed: 0 };
    const removed = await this.suppressions.clearForTenantEmail(args.tenantId, c.email);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.email_block_cleared',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { removed },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return { removed };
  }

  private async findOrThrow(tenantId: string, customerId: string): Promise<CustomerWithCounts> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: customerId, deletedAt: null },
          include: CUSTOMER_COUNTS,
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    return row;
  }

  private toDto(row: CustomerWithCounts): CustomerDto {
    return {
      id: row.id,
      marketingOptOutAt: row.marketingOptOutAt?.toISOString() ?? null,
      customerType: row.customerType,
      firstName: row.firstName,
      lastName: row.lastName,
      companyName: row.companyName,
      displayName: displayName(row),
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      email: row.email,
      phone: row.phone,
      address: row.address,
      city: row.city,
      postalCode: row.postalCode,
      country: row.country,
      emergencyContactName: row.emergencyContactName,
      emergencyContactPhone: row.emergencyContactPhone,
      billingEmail: row.billingEmail,
      notes: row.notes,
      tags: row.tags,
      kycVerified: row.kycVerified,
      depositExempt: row.depositExempt,
      isTest: row.isTest,
      kycVerifiedAt: row.kycVerifiedAt ? row.kycVerifiedAt.toISOString() : null,
      portalAccessEnabled: row.portalAccessEnabled,
      activeContracts: row._count?.contracts ?? 0,
      pendingReservations: row._count?.reservations ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
