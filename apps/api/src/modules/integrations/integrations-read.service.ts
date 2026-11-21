import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { subtractAmounts, toCents } from '../../common/money';
import { pageArgs, type PageRequest, toPage } from '../../common/pagination';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  PublicApiContractDto,
  PublicApiCustomerDto,
  PublicApiInvoiceDto,
  PublicApiPageDto,
} from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PUBLIC_CONTRACT_STATUSES = [
  'draft',
  'active',
  'ending',
  'ended',
  'cancelled',
] as const;
/** Las facturas en borrador no salen por la API: aún no son facturas. */
export const PUBLIC_INVOICE_STATUSES = [
  'issued',
  'paid',
  'overdue',
  'cancelled',
  'refunded',
  'partially_refunded',
  'rectified',
] as const;

type ContractStatus = (typeof PUBLIC_CONTRACT_STATUSES)[number];
type InvoiceStatus = (typeof PUBLIC_INVOICE_STATUSES)[number];

export interface ReadFilters {
  updatedSince?: string;
  status?: string;
  customerId?: string;
  contractId?: string;
  email?: string;
}

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const money = (v: { toString(): string } | number): number => toCents(v) / 100;

const CONTRACT_SELECT = {
  id: true,
  contractNumber: true,
  status: true,
  customerId: true,
  unitId: true,
  startDate: true,
  endDate: true,
  signedAt: true,
  endingRequestedAt: true,
  endedAt: true,
  cancelledAt: true,
  priceMonthly: true,
  discountAmount: true,
  depositAmount: true,
  depositStatus: true,
  billingIntervalMonths: true,
  autoRenew: true,
  createdAt: true,
  updatedAt: true,
  unit: { select: { code: true, facilityId: true, facility: { select: { name: true } } } },
} satisfies Prisma.ContractSelect;

const INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  status: true,
  invoiceType: true,
  kind: true,
  customerId: true,
  contractId: true,
  rectifiesInvoiceId: true,
  issueDate: true,
  dueDate: true,
  periodStart: true,
  periodEnd: true,
  subtotal: true,
  taxAmount: true,
  total: true,
  amountPaid: true,
  amountRefunded: true,
  withholdingAmount: true,
  currency: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: {
      description: true,
      quantity: true,
      unitPrice: true,
      taxRate: true,
      taxCategory: true,
      taxAmount: true,
      total: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

const CUSTOMER_SELECT = {
  id: true,
  customerType: true,
  firstName: true,
  lastName: true,
  companyName: true,
  email: true,
  billingEmail: true,
  phone: true,
  documentType: true,
  documentNumber: true,
  address: true,
  city: true,
  postalCode: true,
  country: true,
  locale: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

/**
 * Lectura de la API pública (clave de API). Todo pasa por `withTenant` con
 * el tenant de la clave: RLS garantiza que nunca sale nada de otro negocio.
 * Orden por id ascendente (UUID v7 = orden de alta): una integración puede
 * recorrer todo con `nextCursor` sin saltarse ni repetir filas.
 */
@Injectable()
export class IntegrationsReadService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------ inquilinos

  async listCustomers(
    tenantId: string,
    page: PageRequest,
    filters: ReadFilters,
  ): Promise<PublicApiPageDto<PublicApiCustomerDto>> {
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      isTest: false,
      ...this.updatedSince(filters.updatedSince),
      ...(filters.email
        ? { email: { equals: filters.email.trim(), mode: 'insensitive' as const } }
        : {}),
    };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where,
          select: CUSTOMER_SELECT,
          orderBy: { id: 'asc' },
          ...pageArgs(page),
        }),
      tenantId,
    );
    return this.page(rows, page, toCustomer);
  }

  async getCustomer(tenantId: string, id: string): Promise<PublicApiCustomerDto> {
    const row = UUID_RE.test(id)
      ? await this.prisma.withTenant(
          (tx) =>
            tx.customer.findFirst({
              where: { id, deletedAt: null, isTest: false },
              select: CUSTOMER_SELECT,
            }),
          tenantId,
        )
      : null;
    if (!row) throw notFound('customer_not_found', 'Inquilino no encontrado.');
    return toCustomer(row);
  }

  // ------------------------------------------------------------ contratos

  async listContracts(
    tenantId: string,
    page: PageRequest,
    filters: ReadFilters,
  ): Promise<PublicApiPageDto<PublicApiContractDto>> {
    const status = this.status(filters.status, PUBLIC_CONTRACT_STATUSES);
    this.assertId(filters.customerId);
    const where: Prisma.ContractWhereInput = {
      deletedAt: null,
      ...this.updatedSince(filters.updatedSince),
      ...(status ? { status: status as ContractStatus } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
    };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where,
          select: CONTRACT_SELECT,
          orderBy: { id: 'asc' },
          ...pageArgs(page),
        }),
      tenantId,
    );
    return this.page(rows, page, toContract);
  }

  async getContract(tenantId: string, id: string): Promise<PublicApiContractDto> {
    const row = UUID_RE.test(id)
      ? await this.prisma.withTenant(
          (tx) =>
            tx.contract.findFirst({ where: { id, deletedAt: null }, select: CONTRACT_SELECT }),
          tenantId,
        )
      : null;
    if (!row) throw notFound('contract_not_found', 'Contrato no encontrado.');
    return toContract(row);
  }

  // ------------------------------------------------------------ facturas

  async listInvoices(
    tenantId: string,
    page: PageRequest,
    filters: ReadFilters,
  ): Promise<PublicApiPageDto<PublicApiInvoiceDto>> {
    const status = this.status(filters.status, PUBLIC_INVOICE_STATUSES);
    this.assertId(filters.customerId);
    this.assertId(filters.contractId);
    const where: Prisma.InvoiceWhereInput = {
      deletedAt: null,
      status: status ? (status as InvoiceStatus) : { not: 'draft' },
      ...this.updatedSince(filters.updatedSince),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.contractId ? { contractId: filters.contractId } : {}),
    };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where,
          select: INVOICE_SELECT,
          orderBy: { id: 'asc' },
          ...pageArgs(page),
        }),
      tenantId,
    );
    return this.page(rows, page, toInvoice);
  }

  async getInvoice(tenantId: string, id: string): Promise<PublicApiInvoiceDto> {
    const row = UUID_RE.test(id)
      ? await this.prisma.withTenant(
          (tx) =>
            tx.invoice.findFirst({
              where: { id, deletedAt: null, status: { not: 'draft' } },
              select: INVOICE_SELECT,
            }),
          tenantId,
        )
      : null;
    if (!row) throw notFound('invoice_not_found', 'Factura no encontrada.');
    return toInvoice(row);
  }

  // ------------------------------------------------------------ internos

  private page<R extends { id: string }, D>(
    rows: R[],
    page: PageRequest,
    map: (r: R) => D,
  ): PublicApiPageDto<D> {
    const { items, nextCursor } = toPage(rows, page);
    return { data: items.map(map), nextCursor };
  }

  private updatedSince(value: string | undefined): { updatedAt?: { gte: Date } } {
    if (!value) return {};
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException({
        code: 'invalid_date',
        message: '`updatedSince` debe ser una fecha ISO 8601 (por ejemplo 2026-01-31T00:00:00Z).',
      });
    }
    return { updatedAt: { gte: date } };
  }

  private status(value: string | undefined, allowed: readonly string[]): string | undefined {
    if (!value) return undefined;
    if (!allowed.includes(value)) {
      throw new BadRequestException({
        code: 'invalid_status',
        message: `Estado no válido. Valores posibles: ${allowed.join(', ')}.`,
      });
    }
    return value;
  }

  private assertId(value: string | undefined): void {
    if (value && !UUID_RE.test(value)) {
      throw new BadRequestException({ code: 'invalid_id', message: 'Identificador no válido.' });
    }
  }
}

function notFound(code: string, message: string): NotFoundException {
  return new NotFoundException({ code, message });
}

function toCustomer(r: Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>) {
  const displayName =
    r.customerType === 'business'
      ? (r.companyName ?? '').trim()
      : [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
  return {
    id: r.id,
    type: r.customerType,
    firstName: r.firstName,
    lastName: r.lastName,
    companyName: r.companyName,
    displayName,
    email: r.email,
    billingEmail: r.billingEmail,
    phone: r.phone,
    documentType: r.documentType,
    documentNumber: r.documentNumber,
    address: r.address,
    city: r.city,
    postalCode: r.postalCode,
    country: r.country,
    locale: r.locale,
    tags: r.tags,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  } satisfies PublicApiCustomerDto;
}

function toContract(
  r: Prisma.ContractGetPayload<{ select: typeof CONTRACT_SELECT }>,
): PublicApiContractDto {
  return {
    id: r.id,
    contractNumber: r.contractNumber,
    status: r.status,
    customerId: r.customerId,
    unitId: r.unitId,
    unitCode: r.unit.code,
    facilityId: r.unit.facilityId,
    facilityName: r.unit.facility.name,
    startDate: day(r.startDate) ?? '',
    endDate: day(r.endDate),
    signedAt: iso(r.signedAt),
    endingRequestedAt: iso(r.endingRequestedAt),
    endedAt: iso(r.endedAt),
    cancelledAt: iso(r.cancelledAt),
    priceMonthly: money(r.priceMonthly),
    discountAmount: money(r.discountAmount),
    depositAmount: money(r.depositAmount),
    depositStatus: r.depositStatus,
    billingIntervalMonths: r.billingIntervalMonths,
    autoRenew: r.autoRenew,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toInvoice(
  r: Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>,
): PublicApiInvoiceDto {
  const total = money(r.total);
  const amountPaid = money(r.amountPaid);
  const pending =
    r.status === 'issued' || r.status === 'overdue'
      ? Math.max(0, subtractAmounts(total, amountPaid))
      : 0;
  return {
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    status: r.status as PublicApiInvoiceDto['status'],
    invoiceType: r.invoiceType,
    kind: r.kind,
    customerId: r.customerId,
    contractId: r.contractId,
    rectifiesInvoiceId: r.rectifiesInvoiceId,
    issueDate: day(r.issueDate),
    dueDate: day(r.dueDate),
    periodStart: day(r.periodStart),
    periodEnd: day(r.periodEnd),
    subtotal: money(r.subtotal),
    taxAmount: money(r.taxAmount),
    total,
    amountPaid,
    amountRefunded: money(r.amountRefunded),
    withholdingAmount: money(r.withholdingAmount),
    amountPending: pending,
    currency: r.currency,
    paidAt: iso(r.paidAt),
    items: r.items.map((i) => ({
      description: i.description,
      quantity: Number(i.quantity),
      unitPrice: money(i.unitPrice),
      taxRate: Number(i.taxRate),
      taxCategory: i.taxCategory,
      taxAmount: money(i.taxAmount),
      total: money(i.total),
    })),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
