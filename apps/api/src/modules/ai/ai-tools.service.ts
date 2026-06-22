import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { AiToolDef } from './ai-provider';

function name(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return 'Sin cliente';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Herramientas de **solo lectura** que el asistente puede invocar. Todas se
 * ejecutan con el contexto del tenant (`withTenant` → RLS), de modo que nunca
 * pueden filtrar datos de otro tenant.
 */
@Injectable()
export class AiToolsService {
  constructor(private readonly prisma: PrismaService) {}

  definitions(): AiToolDef[] {
    return [
      {
        name: 'get_business_metrics',
        description:
          'Métricas globales del negocio: MRR (ingreso recurrente mensual), nº de contratos activos, ocupación física y total pendiente de cobro.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'get_occupancy',
        description: 'Ocupación de trasteros: total, ocupados, disponibles y desglose por local.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'list_overdue_invoices',
        description:
          'Lista las facturas vencidas (impagadas) con cliente, importe pendiente y vencimiento.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'search_customers',
        description: 'Busca clientes por nombre, email o documento. Devuelve hasta 10 con su id.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Texto a buscar' } },
          required: ['query'],
        },
      },
      {
        name: 'get_customer_summary',
        description:
          'Resumen de un cliente por su id: datos, contratos activos (trastero y cuota) y facturas pendientes con la deuda total.',
        input_schema: {
          type: 'object',
          properties: { customerId: { type: 'string', description: 'UUID del cliente' } },
          required: ['customerId'],
        },
      },
    ];
  }

  async execute(
    tenantId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    switch (toolName) {
      case 'get_business_metrics':
        return JSON.stringify(await this.businessMetrics(tenantId));
      case 'get_occupancy':
        return JSON.stringify(await this.occupancy(tenantId));
      case 'list_overdue_invoices':
        return JSON.stringify(await this.overdueInvoices(tenantId));
      case 'search_customers':
        return JSON.stringify(await this.searchCustomers(tenantId, String(input.query ?? '')));
      case 'get_customer_summary':
        return JSON.stringify(await this.customerSummary(tenantId, String(input.customerId ?? '')));
      default:
        return JSON.stringify({ error: `Herramienta desconocida: ${toolName}` });
    }
  }

  private async businessMetrics(tenantId: string) {
    return this.prisma.withTenant(async (tx) => {
      const active = await tx.contract.findMany({
        where: { tenantId, status: { in: ['active', 'ending'] } },
        select: { priceMonthly: true },
      });
      const mrr = active.reduce((s, c) => s + Number(c.priceMonthly), 0);
      const units = await tx.unit.groupBy({ by: ['status'], where: { tenantId }, _count: true });
      const total = units.reduce((s, u) => s + u._count, 0);
      const occupied = units.find((u) => u.status === 'occupied')?._count ?? 0;
      const pending = await tx.invoice.findMany({
        where: { tenantId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
        select: { total: true, amountPaid: true },
      });
      const pendingTotal = pending.reduce(
        (s, i) => s + Math.max(0, Number(i.total) - Number(i.amountPaid)),
        0,
      );
      return {
        mrr: Math.round(mrr * 100) / 100,
        activeContracts: active.length,
        occupancyPct: total > 0 ? Math.round((occupied / total) * 100) : 0,
        pendingToCollect: Math.round(pendingTotal * 100) / 100,
        currency: 'EUR',
      };
    }, tenantId);
  }

  private async occupancy(tenantId: string) {
    return this.prisma.withTenant(async (tx) => {
      const grouped = await tx.unit.groupBy({
        by: ['facilityId', 'status'],
        where: { tenantId },
        _count: true,
      });
      const facilities = await tx.facility.findMany({
        where: { tenantId, deletedAt: null },
        select: { id: true, name: true },
      });
      const byFacility = facilities.map((f) => {
        const rows = grouped.filter((g) => g.facilityId === f.id);
        const total = rows.reduce((s, r) => s + r._count, 0);
        const occupied = rows.find((r) => r.status === 'occupied')?._count ?? 0;
        const available = rows.find((r) => r.status === 'available')?._count ?? 0;
        return { facility: f.name, total, occupied, available };
      });
      const total = byFacility.reduce((s, f) => s + f.total, 0);
      const occupied = byFacility.reduce((s, f) => s + f.occupied, 0);
      return {
        total,
        occupied,
        available: byFacility.reduce((s, f) => s + f.available, 0),
        occupancyPct: total > 0 ? Math.round((occupied / total) * 100) : 0,
        byFacility,
      };
    }, tenantId);
  }

  private async overdueInvoices(tenantId: string) {
    return this.prisma.withTenant(async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: { tenantId, status: 'overdue', deletedAt: null },
        select: {
          invoiceNumber: true,
          total: true,
          amountPaid: true,
          dueDate: true,
          customer: {
            select: { customerType: true, firstName: true, lastName: true, companyName: true },
          },
        },
        orderBy: { dueDate: 'asc' },
        take: 20,
      });
      return invoices.map((i) => ({
        invoiceNumber: i.invoiceNumber,
        customer: name(i.customer),
        pending: Math.max(0, Number(i.total) - Number(i.amountPaid)),
        dueDate: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : null,
      }));
    }, tenantId);
  }

  private async searchCustomers(tenantId: string, query: string) {
    const q = query.trim();
    if (!q) return [];
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.customer.findMany({
        where: {
          tenantId,
          deletedAt: null,
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { companyName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { documentNumber: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          customerType: true,
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
        },
        take: 10,
      });
      return rows.map((c) => ({ id: c.id, name: name(c), email: c.email }));
    }, tenantId);
  }

  private async customerSummary(tenantId: string, customerId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(customerId)) return { error: 'customerId no válido' };
    return this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, tenantId, deletedAt: null },
        select: {
          customerType: true,
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
          phone: true,
        },
      });
      if (!customer) return { error: 'Cliente no encontrado' };
      const contracts = await tx.contract.findMany({
        where: { tenantId, customerId, status: { in: ['active', 'ending'] } },
        select: { priceMonthly: true, unit: { select: { code: true } } },
      });
      const invoices = await tx.invoice.findMany({
        where: { tenantId, customerId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
        select: { invoiceNumber: true, total: true, amountPaid: true, status: true },
      });
      const debt = invoices.reduce(
        (s, i) => s + Math.max(0, Number(i.total) - Number(i.amountPaid)),
        0,
      );
      return {
        name: name(customer),
        email: customer.email,
        phone: customer.phone,
        activeContracts: contracts.map((c) => ({
          unit: c.unit?.code ?? null,
          monthlyPrice: Number(c.priceMonthly),
        })),
        pendingInvoices: invoices.length,
        totalDebt: Math.round(debt * 100) / 100,
      };
    }, tenantId);
  }
}
