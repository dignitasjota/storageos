import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import { ACTION_PERMISSIONS, AiActionsService } from './ai-actions.service';

import type { AiToolDef } from './ai-provider';
import type { Prisma } from '@storageos/database';
import type { AiActionType, Permission } from '@storageos/shared';

/**
 * Quién pregunta: las herramientas respetan lo mismo que el resto del panel —
 * sus permisos (solo se le ofrecen las herramientas que su rol permite) y su
 * alcance por local (`facilityScope`: null = todos los locales).
 */
export interface AiToolContext {
  tenantId: string;
  permissions: readonly Permission[];
  facilityScope: string[] | null;
  /** Para las herramientas que PROPONEN acciones (quién y en qué conversación). */
  userId?: string;
  conversationId?: string;
  /** Ids de las acciones propuestas en esta vuelta (las rellena `execute`). */
  proposedActionIds?: string[];
}

/** Permiso necesario para cada herramienta (mismo que el endpoint equivalente). */
const TOOL_PERMISSIONS: Record<string, Permission> = {
  get_business_metrics: 'analytics:read',
  get_occupancy: 'units:read',
  list_overdue_invoices: 'invoices:read',
  search_customers: 'customers:read',
  get_customer_summary: 'customers:read',
  get_monthly_revenue: 'analytics:read',
  list_contracts_ending: 'contracts:read',
  get_unit_availability: 'units:read',
  get_leads_summary: 'leads:read',
  list_open_tasks: 'tasks:read',
  list_open_incidents: 'incidents:read',
  get_expenses_summary: 'expenses:read',
  propose_create_task: ACTION_PERMISSIONS.create_task,
  propose_payment_reminder: ACTION_PERMISSIONS.payment_reminder,
  propose_customer_message: ACTION_PERMISSIONS.customer_message,
};

/** Herramienta de propuesta → tipo de acción. */
const PROPOSAL_TOOLS: Record<string, AiActionType> = {
  propose_create_task: 'create_task',
  propose_payment_reminder: 'payment_reminder',
  propose_customer_message: 'customer_message',
};

/** Entidades con local opcional (tareas, incidencias, gastos): las suyas + las generales. */
function optionalFacilityScope(scope: string[] | null): {
  OR?: ({ facilityId: { in: string[] } } | { facilityId: null })[];
} {
  return scope ? { OR: [{ facilityId: { in: scope } }, { facilityId: null }] } : {};
}

/** Entero acotado a partir de la entrada del modelo (que puede venir como string o fuera de rango). */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const MS_PER_DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Facturas visibles para un usuario limitado por local (mismo criterio que `InvoicesService.list`). */
function invoiceScope(scope: string[] | null): Prisma.InvoiceWhereInput {
  if (!scope) return {};
  return { OR: [{ contract: { unit: { facilityId: { in: scope } } } }, { contractId: null }] };
}

function contractScope(scope: string[] | null): Prisma.ContractWhereInput {
  return scope ? { unit: { facilityId: { in: scope } } } : {};
}

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
 * pueden filtrar datos de otro tenant, y respetan los permisos y el alcance por
 * local del usuario que pregunta (como el resto del panel).
 */
@Injectable()
export class AiToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: AiActionsService,
  ) {}

  /** Herramientas que se ofrecen al modelo: solo las que el usuario tiene permiso a usar. */
  definitions(ctx: Pick<AiToolContext, 'permissions'>): AiToolDef[] {
    return this.allDefinitions().filter((d) => this.allowed(ctx, d.name));
  }

  private allowed(ctx: Pick<AiToolContext, 'permissions'>, toolName: string): boolean {
    const required = TOOL_PERMISSIONS[toolName];
    return !!required && ctx.permissions.includes(required);
  }

  private allDefinitions(): AiToolDef[] {
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
      {
        name: 'get_monthly_revenue',
        description:
          'Ingresos por mes: importe facturado (facturas emitidas) y cobrado (pagos recibidos) de los últimos N meses, incluido el actual.',
        input_schema: {
          type: 'object',
          properties: {
            months: { type: 'integer', description: 'Meses a incluir (1-12, por defecto 6)' },
          },
        },
      },
      {
        name: 'list_contracts_ending',
        description:
          'Contratos activos que terminan en los próximos N días: cliente, trastero, fecha de fin, cuota y si se renuevan solos.',
        input_schema: {
          type: 'object',
          properties: {
            days: { type: 'integer', description: 'Ventana en días (1-180, por defecto 60)' },
          },
        },
      },
      {
        name: 'get_unit_availability',
        description:
          'Trasteros disponibles por local y tipo, con el precio mensual más bajo («desde») y el total de cada tipo.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'get_leads_summary',
        description:
          'Leads (interesados) recibidos en los últimos N días: cuántos por estado y por origen, y cuántos se ganaron.',
        input_schema: {
          type: 'object',
          properties: {
            days: { type: 'integer', description: 'Ventana en días (1-365, por defecto 30)' },
          },
        },
      },
      {
        name: 'list_open_tasks',
        description:
          'Tareas abiertas o en curso: título, prioridad, fecha límite y si están vencidas.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'list_open_incidents',
        description:
          'Incidencias sin resolver (reportadas o en investigación): título, gravedad y fecha.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'propose_create_task',
        description:
          'PROPONE crear una tarea. No la crea: el usuario debe confirmarla en pantalla. Úsala cuando pida apuntar o programar algo.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Título breve de la tarea' },
            description: { type: 'string' },
            dueDate: { type: 'string', description: 'Fecha límite YYYY-MM-DD' },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          },
          required: ['title'],
        },
      },
      {
        name: 'propose_payment_reminder',
        description:
          'PROPONE enviar por email un recordatorio de pago de una factura pendiente. No lo envía: el usuario debe confirmarlo.',
        input_schema: {
          type: 'object',
          properties: { invoiceNumber: { type: 'string', description: 'Número de la factura' } },
          required: ['invoiceNumber'],
        },
      },
      {
        name: 'propose_customer_message',
        description:
          'PROPONE enviar un mensaje a un inquilino por el chat de su portal. No lo envía: el usuario debe confirmarlo. Busca antes el id del cliente con search_customers.',
        input_schema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: 'UUID del cliente' },
            body: { type: 'string', description: 'Texto del mensaje, en español' },
          },
          required: ['customerId', 'body'],
        },
      },
      {
        name: 'get_expenses_summary',
        description:
          'Gastos del negocio en los últimos N meses, incluido el actual: total, por categoría y por local.',
        input_schema: {
          type: 'object',
          properties: {
            months: { type: 'integer', description: 'Meses a incluir (1-12, por defecto 3)' },
          },
        },
      },
    ];
  }

  async execute(
    ctx: AiToolContext,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    // Defensa en profundidad: el modelo podría pedir una herramienta que no se
    // le ofreció (o una inventada).
    if (!this.allowed(ctx, toolName)) {
      return JSON.stringify({ error: `Herramienta no disponible: ${toolName}` });
    }
    const { tenantId, facilityScope: scope } = ctx;
    const actionType = PROPOSAL_TOOLS[toolName];
    if (actionType) {
      if (!ctx.userId || !ctx.conversationId) {
        return JSON.stringify({
          error: 'Las acciones solo se pueden proponer en una conversación',
        });
      }
      const proposal = await this.actions.propose(
        {
          tenantId,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          facilityScope: scope,
        },
        actionType,
        input,
      );
      if (!proposal.ok) return JSON.stringify({ error: proposal.error });
      ctx.proposedActionIds?.push(proposal.actionId);
      return JSON.stringify({
        status: 'pending_confirmation',
        summary: proposal.summary,
        note: 'Propuesta registrada. El usuario debe confirmarla en pantalla: no digas que ya está hecha.',
      });
    }
    switch (toolName) {
      case 'get_business_metrics':
        return JSON.stringify(await this.businessMetrics(tenantId, scope));
      case 'get_occupancy':
        return JSON.stringify(await this.occupancy(tenantId, scope));
      case 'list_overdue_invoices':
        return JSON.stringify(await this.overdueInvoices(tenantId, scope));
      case 'search_customers':
        return JSON.stringify(await this.searchCustomers(tenantId, String(input.query ?? '')));
      case 'get_customer_summary':
        return JSON.stringify(
          await this.customerSummary(tenantId, String(input.customerId ?? ''), scope),
        );
      case 'get_monthly_revenue':
        return JSON.stringify(
          await this.monthlyRevenue(tenantId, scope, clampInt(input.months, 1, 12, 6)),
        );
      case 'list_contracts_ending':
        return JSON.stringify(
          await this.contractsEnding(tenantId, scope, clampInt(input.days, 1, 180, 60)),
        );
      case 'get_unit_availability':
        return JSON.stringify(await this.unitAvailability(tenantId, scope));
      case 'get_leads_summary':
        return JSON.stringify(await this.leadsSummary(tenantId, clampInt(input.days, 1, 365, 30)));
      case 'list_open_tasks':
        return JSON.stringify(await this.openTasks(tenantId, scope));
      case 'list_open_incidents':
        return JSON.stringify(await this.openIncidents(tenantId, scope));
      case 'get_expenses_summary':
        return JSON.stringify(
          await this.expensesSummary(tenantId, scope, clampInt(input.months, 1, 12, 3)),
        );
      default:
        return JSON.stringify({ error: `Herramienta desconocida: ${toolName}` });
    }
  }

  private async businessMetrics(tenantId: string, scope: string[] | null) {
    return this.prisma.withTenant(async (tx) => {
      const active = await tx.contract.findMany({
        where: { tenantId, status: { in: ['active', 'ending'] }, ...contractScope(scope) },
        select: { priceMonthly: true },
      });
      const mrr = active.reduce((s, c) => s + Number(c.priceMonthly), 0);
      const units = await tx.unit.groupBy({
        by: ['status'],
        where: { tenantId, ...(scope ? { facilityId: { in: scope } } : {}) },
        _count: true,
      });
      const total = units.reduce((s, u) => s + u._count, 0);
      const occupied = units.find((u) => u.status === 'occupied')?._count ?? 0;
      const pending = await tx.invoice.findMany({
        where: {
          tenantId,
          status: { in: ['issued', 'overdue'] },
          deletedAt: null,
          ...invoiceScope(scope),
        },
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

  private async occupancy(tenantId: string, scope: string[] | null) {
    return this.prisma.withTenant(async (tx) => {
      const facilityFilter = scope ? { in: scope } : undefined;
      const grouped = await tx.unit.groupBy({
        by: ['facilityId', 'status'],
        where: { tenantId, ...(facilityFilter ? { facilityId: facilityFilter } : {}) },
        _count: true,
      });
      const facilities = await tx.facility.findMany({
        where: { tenantId, deletedAt: null, ...(facilityFilter ? { id: facilityFilter } : {}) },
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

  private async overdueInvoices(tenantId: string, scope: string[] | null) {
    return this.prisma.withTenant(async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: { tenantId, status: 'overdue', deletedAt: null, ...invoiceScope(scope) },
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

  private async customerSummary(tenantId: string, customerId: string, scope: string[] | null) {
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
        where: {
          tenantId,
          customerId,
          status: { in: ['active', 'ending'] },
          ...contractScope(scope),
        },
        select: { priceMonthly: true, unit: { select: { code: true } } },
      });
      const invoices = await tx.invoice.findMany({
        where: {
          tenantId,
          customerId,
          status: { in: ['issued', 'overdue'] },
          deletedAt: null,
          ...invoiceScope(scope),
        },
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

  /** Primer día (UTC) del mes, `offset` meses atrás respecto al actual. */
  private monthStart(offset: number): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  }

  private async monthlyRevenue(tenantId: string, scope: string[] | null, months: number) {
    const from = this.monthStart(months - 1);
    return this.prisma.withTenant(async (tx) => {
      const [invoices, payments] = await Promise.all([
        tx.invoice.findMany({
          where: {
            tenantId,
            deletedAt: null,
            status: { notIn: ['draft', 'cancelled'] },
            issueDate: { gte: from },
            ...invoiceScope(scope),
          },
          select: { issueDate: true, total: true },
        }),
        tx.payment.findMany({
          where: {
            tenantId,
            status: 'succeeded',
            paidAt: { gte: from },
            ...(scope ? { invoice: invoiceScope(scope) } : {}),
          },
          select: { paidAt: true, amount: true },
        }),
      ]);
      const buckets = new Map<string, { invoiced: number; collected: number }>();
      for (let i = months - 1; i >= 0; i--) {
        buckets.set(this.monthStart(i).toISOString().slice(0, 7), { invoiced: 0, collected: 0 });
      }
      for (const inv of invoices) {
        const b = inv.issueDate ? buckets.get(inv.issueDate.toISOString().slice(0, 7)) : undefined;
        if (b) b.invoiced += Number(inv.total);
      }
      for (const p of payments) {
        const b = p.paidAt ? buckets.get(p.paidAt.toISOString().slice(0, 7)) : undefined;
        if (b) b.collected += Number(p.amount);
      }
      return {
        currency: 'EUR',
        months: [...buckets].map(([month, b]) => ({
          month,
          invoiced: round2(b.invoiced),
          collected: round2(b.collected),
        })),
      };
    }, tenantId);
  }

  private async contractsEnding(tenantId: string, scope: string[] | null, days: number) {
    const now = new Date();
    const until = new Date(now.getTime() + days * MS_PER_DAY);
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.contract.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ['active', 'ending'] },
          endDate: { not: null, gte: now, lte: until },
          ...contractScope(scope),
        },
        select: {
          contractNumber: true,
          status: true,
          endDate: true,
          autoRenew: true,
          priceMonthly: true,
          unit: { select: { code: true, facility: { select: { name: true } } } },
          customer: {
            select: { customerType: true, firstName: true, lastName: true, companyName: true },
          },
        },
        orderBy: { endDate: 'asc' },
        take: 30,
      });
      return rows.map((c) => ({
        contract: c.contractNumber,
        customer: name(c.customer),
        unit: c.unit?.code ?? null,
        facility: c.unit?.facility?.name ?? null,
        endDate: c.endDate?.toISOString().slice(0, 10) ?? null,
        monthlyPrice: Number(c.priceMonthly),
        autoRenew: c.autoRenew,
        moveOutRequested: c.status === 'ending',
      }));
    }, tenantId);
  }

  private async unitAvailability(tenantId: string, scope: string[] | null) {
    return this.prisma.withTenant(async (tx) => {
      const facilityFilter = scope ? { facilityId: { in: scope } } : {};
      const [all, available, facilities, types] = await Promise.all([
        tx.unit.groupBy({
          by: ['facilityId', 'unitTypeId'],
          where: { tenantId, ...facilityFilter },
          _count: true,
        }),
        tx.unit.groupBy({
          by: ['facilityId', 'unitTypeId'],
          where: { tenantId, status: 'available', ...facilityFilter },
          _count: true,
          _min: { basePriceMonthly: true },
        }),
        tx.facility.findMany({
          where: { tenantId, deletedAt: null, ...(scope ? { id: { in: scope } } : {}) },
          select: { id: true, name: true },
        }),
        tx.unitType.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      ]);
      const facilityName = new Map(facilities.map((f) => [f.id, f.name]));
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      return all
        .filter((g) => facilityName.has(g.facilityId))
        .map((g) => {
          const av = available.find(
            (a) => a.facilityId === g.facilityId && a.unitTypeId === g.unitTypeId,
          );
          const from = av?._min.basePriceMonthly;
          return {
            facility: facilityName.get(g.facilityId),
            unitType: typeName.get(g.unitTypeId) ?? null,
            total: g._count,
            available: av?._count ?? 0,
            priceFrom: from != null ? Number(from) : null,
          };
        });
    }, tenantId);
  }

  /** Leads a nivel de empresa (en el panel tampoco se acotan por local). */
  private async leadsSummary(tenantId: string, days: number) {
    const since = new Date(Date.now() - days * MS_PER_DAY);
    return this.prisma.withTenant(async (tx) => {
      const where = { tenantId, deletedAt: null, createdAt: { gte: since } };
      const [byStatus, bySource] = await Promise.all([
        tx.lead.groupBy({ by: ['status'], where, _count: true }),
        tx.lead.groupBy({ by: ['source'], where, _count: true }),
      ]);
      const total = byStatus.reduce((s, r) => s + r._count, 0);
      const won = byStatus.find((r) => r.status === 'won')?._count ?? 0;
      return {
        days,
        total,
        won,
        conversionPct: total > 0 ? Math.round((won / total) * 100) : 0,
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
        bySource: Object.fromEntries(bySource.map((r) => [r.source, r._count])),
      };
    }, tenantId);
  }

  private async openTasks(tenantId: string, scope: string[] | null) {
    const today = new Date().toISOString().slice(0, 10);
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.task.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ['open', 'in_progress'] },
          ...optionalFacilityScope(scope),
        },
        select: { title: true, status: true, priority: true, dueDate: true },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        take: 30,
      });
      return rows.map((t) => {
        const due = t.dueDate?.toISOString().slice(0, 10) ?? null;
        return {
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: due,
          overdue: due !== null && due < today,
        };
      });
    }, tenantId);
  }

  private async openIncidents(tenantId: string, scope: string[] | null) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.incident.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ['reported', 'investigating'] },
          ...optionalFacilityScope(scope),
        },
        select: { title: true, status: true, severity: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      return rows.map((i) => ({
        title: i.title,
        status: i.status,
        severity: i.severity,
        reportedAt: i.createdAt.toISOString().slice(0, 10),
      }));
    }, tenantId);
  }

  private async expensesSummary(tenantId: string, scope: string[] | null, months: number) {
    const from = this.monthStart(months - 1);
    return this.prisma.withTenant(async (tx) => {
      const where = { tenantId, expenseDate: { gte: from }, ...optionalFacilityScope(scope) };
      const [byCategory, byFacility, facilities] = await Promise.all([
        tx.expense.groupBy({ by: ['category'], where, _sum: { amount: true } }),
        tx.expense.groupBy({ by: ['facilityId'], where, _sum: { amount: true } }),
        tx.facility.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      ]);
      const facilityName = new Map(facilities.map((f) => [f.id, f.name]));
      const total = byCategory.reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);
      return {
        currency: 'EUR',
        from: from.toISOString().slice(0, 10),
        total: round2(total),
        byCategory: Object.fromEntries(
          byCategory.map((r) => [r.category, round2(Number(r._sum.amount ?? 0))]),
        ),
        byFacility: byFacility.map((r) => ({
          facility: r.facilityId ? (facilityName.get(r.facilityId) ?? null) : 'General (sin local)',
          amount: round2(Number(r._sum.amount ?? 0)),
        })),
      };
    }, tenantId);
  }
}
