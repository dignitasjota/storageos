import { NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import { zonedDayStart, zonedNextDayStart } from '../../common/format';

import type { AiToolDef } from './ai-provider';
import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '@storageos/database';
import type { Permission } from '@storageos/shared';

/**
 * Herramientas genéricas del asistente del panel: buscar, ver la ficha de
 * cualquier registro, listar con filtros y unas pocas de negocio (cobros del
 * mes, deudores, calendario, configuración y evolución). Todas de solo
 * lectura, con el contexto del tenant (RLS) y respetando los permisos y el
 * alcance por local del usuario, como el resto del panel.
 */

type Tx = Prisma.TransactionClient;
type Scope = string[] | null;
type Input = Record<string, unknown>;

interface Ctx {
  tenantId: string;
  scope: Scope;
  permissions: readonly Permission[];
}

const LIMIT = 30;
const UUID = /^[0-9a-f-]{36}$/i;

const RECORD_TYPES = {
  customer: 'customers:read',
  contract: 'contracts:read',
  unit: 'units:read',
  invoice: 'invoices:read',
  facility: 'facilities:read',
  reservation: 'reservations:read',
  incident: 'incidents:read',
  task: 'tasks:read',
  lead: 'leads:read',
} as const satisfies Record<string, Permission>;
type RecordType = keyof typeof RECORD_TYPES;

const LIST_TYPES = {
  invoices: 'invoices:read',
  payments: 'payments:read',
  contracts: 'contracts:read',
  units: 'units:read',
  reservations: 'reservations:read',
  waitlist: 'reservations:read',
  access_logs: 'access:read',
  leads: 'leads:read',
  tasks: 'tasks:read',
  incidents: 'incidents:read',
  expenses: 'expenses:read',
  communications: 'communications:read',
  campaigns: 'communications:read',
  reminders: 'reminders:read',
  coupons: 'promotions:read',
  promotions: 'promotions:read',
  reviews: 'reviews:read',
  unit_change_requests: 'contracts:read',
  payment_plans: 'payments:read',
} as const satisfies Record<string, Permission>;
type ListType = keyof typeof LIST_TYPES;

/** Permiso de las herramientas específicas. */
export const BUSINESS_TOOL_PERMISSIONS = {
  get_collections_month: 'payments:read',
  list_debtors: 'invoices:read',
  get_calendar: 'contracts:read',
  get_business_settings: 'facilities:read',
  get_contracts_trend: 'analytics:read',
} as const satisfies Record<string, Permission>;

/** Herramientas genéricas: se ofrecen si el usuario puede ver alguno de sus tipos. */
export const GENERIC_TOOLS = ['search_records', 'get_record', 'list_records'] as const;

const has = (ctx: Pick<Ctx, 'permissions'>, p: Permission) => ctx.permissions.includes(p);
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);
const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/** `YYYY-MM-DD` válido o undefined. */
function day(value: unknown): string | undefined {
  const s = str(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
}

/** Rango [desde, hasta] (días incluidos) en la zona del negocio. */
function range(input: Input, tz: string): { gte?: Date; lt?: Date } | undefined {
  const from = day(input.from);
  const to = day(input.to);
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: zonedDayStart(from, tz) } : {}),
    ...(to ? { lt: zonedNextDayStart(to, tz) } : {}),
  };
}

function personName(
  c: {
    customerType?: string | null;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string | null {
  if (!c) return null;
  if (c.customerType === 'business' && c.companyName) return c.companyName;
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.companyName || null;
}

const CUSTOMER_NAME = {
  select: { id: true, customerType: true, firstName: true, lastName: true, companyName: true },
} as const;

const unitScope = (s: Scope): Prisma.UnitWhereInput => (s ? { facilityId: { in: s } } : {});
const contractScope = (s: Scope): Prisma.ContractWhereInput =>
  s ? { unit: { facilityId: { in: s } } } : {};
const invoiceScope = (s: Scope): Prisma.InvoiceWhereInput =>
  s
    ? {
        OR: [
          { contract: { unit: { facilityId: { in: s } } } },
          { contractId: null, facilityId: null },
          { contractId: null, facilityId: { in: s } },
        ],
      }
    : {};
/** Entidades con local opcional (tareas, incidencias, gastos, vencimientos). */
const optionalScope = (s: Scope) =>
  s ? { OR: [{ facilityId: { in: s } }, { facilityId: null }] } : {};

const pending = (i: { total: Prisma.Decimal; amountPaid: Prisma.Decimal }) =>
  Math.max(0, Number(i.total) - Number(i.amountPaid));

export class AiBusinessTools {
  constructor(private readonly prisma: PrismaService) {}

  definitions(ctx: Pick<Ctx, 'permissions'>): AiToolDef[] {
    const recordTypes = (Object.keys(RECORD_TYPES) as RecordType[]).filter((t) =>
      has(ctx, RECORD_TYPES[t]),
    );
    const listTypes = (Object.keys(LIST_TYPES) as ListType[]).filter((t) =>
      has(ctx, LIST_TYPES[t]),
    );
    const out: AiToolDef[] = [];
    if (recordTypes.length > 0) {
      out.push(
        {
          name: 'search_records',
          description:
            'Busca en todo el negocio por texto: inquilinos (nombre, email, teléfono, DNI), contratos (número), trasteros (código), facturas (número) y contactos. Devuelve el tipo y el id de cada resultado para usarlos con get_record.',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Texto a buscar' } },
            required: ['query'],
          },
        },
        {
          name: 'get_record',
          description:
            'Ficha completa de un registro. customer: datos, contratos, deuda, últimos cobros, formas de pago y notas. contract: trastero, fechas, cuota, descuentos, fianza, seguro, firma y últimos eventos. unit: estado, tamaño, precio, contrato actual e historial. invoice: líneas, cobros, pendiente y estado en la AEAT. facility: dirección, horario, toque de queda, trasteros por estado y tamaños con precio. También reservation, incident, task y lead. Para contract, unit, invoice y facility vale el número, código o nombre en vez del id.',
          input_schema: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: recordTypes },
              id: { type: 'string', description: 'Id, o número/código/nombre' },
            },
            required: ['type', 'id'],
          },
        },
      );
    }
    if (listTypes.length > 0) {
      out.push({
        name: 'list_records',
        description:
          'Lista registros del negocio con filtros (máx. 30, los más recientes primero). Tipos: invoices (facturas), payments (cobros), contracts, units (trasteros), reservations, waitlist (lista de espera), access_logs (entradas al local y accesos denegados), leads (contactos), tasks, incidents, expenses (gastos), communications (correos y WhatsApp enviados), campaigns, reminders (vencimientos del negocio), coupons, promotions, reviews (valoraciones), unit_change_requests (peticiones de cambio de trastero) y payment_plans (planes de pago). Filtros opcionales: status, from y to (YYYY-MM-DD), customerId, facilityId.',
        input_schema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: listTypes },
            status: { type: 'string', description: 'Estado (p. ej. overdue, active, open)' },
            from: { type: 'string', description: 'Desde (YYYY-MM-DD)' },
            to: { type: 'string', description: 'Hasta (YYYY-MM-DD)' },
            customerId: { type: 'string' },
            facilityId: { type: 'string' },
          },
          required: ['type'],
        },
      });
    }
    const specific: AiToolDef[] = [
      {
        name: 'get_collections_month',
        description:
          'Cobros de un mes: lo que se espera cobrar, lo cobrado, lo pendiente y lo vencido, por forma de pago.',
        input_schema: {
          type: 'object',
          properties: {
            month: { type: 'string', description: 'AAAA-MM (por defecto, el actual)' },
          },
        },
      },
      {
        name: 'list_debtors',
        description:
          'Inquilinos con deuda vencida: importe, nº de facturas, factura más antigua y días de retraso.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'get_calendar',
        description:
          'Agenda entre dos fechas: entradas y salidas de inquilinos, contratos que terminan, reservas, tareas con fecha y vencimientos del negocio.',
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'YYYY-MM-DD (por defecto, hoy)' },
            to: { type: 'string', description: 'YYYY-MM-DD (por defecto, dentro de 7 días)' },
          },
        },
      },
      {
        name: 'get_business_settings',
        description:
          'Configuración del negocio: locales (dirección, contacto, horario, toque de queda), tamaños de trastero con precio y fianza, seguros, formas de cobro activas y ajustes de facturación.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'get_contracts_trend',
        description:
          'Evolución mes a mes de los últimos N meses: contratos firmados, bajas y contratos vivos al cerrar cada mes.',
        input_schema: {
          type: 'object',
          properties: { months: { type: 'integer', description: '1-24, por defecto 12' } },
        },
      },
    ];
    for (const t of specific) {
      if (has(ctx, BUSINESS_TOOL_PERMISSIONS[t.name as keyof typeof BUSINESS_TOOL_PERMISSIONS])) {
        out.push(t);
      }
    }
    return out;
  }

  /** ¿Es una de estas herramientas y la puede usar? */
  allowed(ctx: Pick<Ctx, 'permissions'>, name: string, input: Input): boolean | null {
    if (name === 'get_record') {
      const t = pick(input.type, Object.keys(RECORD_TYPES) as RecordType[]);
      return !!t && has(ctx, RECORD_TYPES[t]);
    }
    if (name === 'list_records') {
      const t = pick(input.type, Object.keys(LIST_TYPES) as ListType[]);
      return !!t && has(ctx, LIST_TYPES[t]);
    }
    if (name === 'search_records') {
      return (Object.values(RECORD_TYPES) as Permission[]).some((p) => has(ctx, p));
    }
    if (name in BUSINESS_TOOL_PERMISSIONS) {
      return has(ctx, BUSINESS_TOOL_PERMISSIONS[name as keyof typeof BUSINESS_TOOL_PERMISSIONS]);
    }
    return null;
  }

  async execute(ctx: Ctx, name: string, input: Input): Promise<unknown> {
    const tz = await this.timezone(ctx.tenantId);
    return this.prisma.withTenant(async (tx) => {
      switch (name) {
        case 'search_records':
          return this.search(tx, ctx, str(input.query));
        case 'get_record':
          return this.record(tx, ctx, input.type as RecordType, str(input.id), tz);
        case 'list_records':
          return this.list(tx, ctx, input.type as ListType, input, tz);
        case 'get_collections_month':
          return this.collectionsMonth(tx, ctx, str(input.month), tz);
        case 'list_debtors':
          return this.debtors(tx, ctx);
        case 'get_calendar':
          return this.calendar(tx, ctx, input, tz);
        case 'get_business_settings':
          return this.settings(tx, ctx);
        case 'get_contracts_trend':
          return this.trend(tx, ctx, input.months);
        default:
          return { error: `Herramienta desconocida: ${name}` };
      }
    }, ctx.tenantId);
  }

  private async timezone(tenantId: string): Promise<string> {
    const t = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      tenantId,
    );
    return t?.timezone || 'Europe/Madrid';
  }

  // ─── Búsqueda ──────────────────────────────────────────────────────────────

  private async search(tx: Tx, ctx: Ctx, q: string) {
    if (q.length < 2) return { error: 'Escribe al menos 2 caracteres' };
    const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
    const like = (v: string) => ({ contains: v, mode: 'insensitive' as const });
    const out: { type: string; id: string; label: string; detail?: string | null }[] = [];
    if (has(ctx, 'customers:read')) {
      const rows = await tx.customer.findMany({
        where: {
          deletedAt: null,
          AND: words.map((w) => ({
            OR: [
              { firstName: like(w) },
              { lastName: like(w) },
              { companyName: like(w) },
              { email: like(w) },
              { phone: like(w) },
              { documentNumber: like(w) },
            ],
          })),
        },
        select: { ...CUSTOMER_NAME.select, email: true, phone: true },
        take: 10,
      });
      for (const c of rows) {
        out.push({
          type: 'customer',
          id: c.id,
          label: personName(c) ?? 'Cliente',
          detail: c.email,
        });
      }
    }
    if (has(ctx, 'contracts:read')) {
      const rows = await tx.contract.findMany({
        where: { deletedAt: null, contractNumber: like(q), ...contractScope(ctx.scope) },
        select: { id: true, contractNumber: true, status: true, customer: CUSTOMER_NAME },
        take: 5,
      });
      for (const c of rows) {
        out.push({
          type: 'contract',
          id: c.id,
          label: c.contractNumber,
          detail: `${c.status} · ${personName(c.customer) ?? ''}`,
        });
      }
    }
    if (has(ctx, 'units:read')) {
      const rows = await tx.unit.findMany({
        where: { code: like(q), ...unitScope(ctx.scope) },
        select: { id: true, code: true, status: true, facility: { select: { name: true } } },
        take: 5,
      });
      for (const u of rows) {
        out.push({
          type: 'unit',
          id: u.id,
          label: u.code,
          detail: `${u.facility.name} · ${u.status}`,
        });
      }
    }
    if (has(ctx, 'invoices:read')) {
      const rows = await tx.invoice.findMany({
        where: { deletedAt: null, invoiceNumber: like(q), ...invoiceScope(ctx.scope) },
        select: { id: true, invoiceNumber: true, status: true, total: true },
        take: 5,
      });
      for (const i of rows) {
        out.push({
          type: 'invoice',
          id: i.id,
          label: i.invoiceNumber,
          detail: `${i.status} · ${Number(i.total)} €`,
        });
      }
    }
    if (has(ctx, 'leads:read')) {
      const rows = await tx.lead.findMany({
        where: {
          deletedAt: null,
          AND: words.map((w) => ({
            OR: [
              { firstName: like(w) },
              { lastName: like(w) },
              { companyName: like(w) },
              { email: like(w) },
              { phone: like(w) },
            ],
          })),
        },
        select: { id: true, firstName: true, lastName: true, companyName: true, status: true },
        take: 5,
      });
      for (const l of rows) {
        out.push({
          type: 'lead',
          id: l.id,
          label: personName(l) ?? 'Contacto',
          detail: l.status,
        });
      }
    }
    return { results: out };
  }

  // ─── Fichas ────────────────────────────────────────────────────────────────

  private async record(tx: Tx, ctx: Ctx, type: RecordType, ref: string, tz: string) {
    if (!ref) return { error: 'Falta el id' };
    const byId = UUID.test(ref);
    switch (type) {
      case 'customer':
        return byId ? this.customer(tx, ctx, ref) : { error: 'Busca antes el id del inquilino' };
      case 'contract':
        return this.contract(tx, ctx, byId ? { id: ref } : { contractNumber: ref });
      case 'unit':
        return this.unit(
          tx,
          ctx,
          byId ? { id: ref } : { code: { equals: ref, mode: 'insensitive' } },
        );
      case 'invoice':
        return this.invoice(tx, ctx, byId ? { id: ref } : { invoiceNumber: ref });
      case 'facility':
        return this.facility(
          tx,
          ctx,
          byId ? { id: ref } : { name: { contains: ref, mode: 'insensitive' } },
        );
      case 'reservation':
        return byId ? this.reservation(tx, ctx, ref) : { error: 'Hace falta el id' };
      case 'incident':
        return byId ? this.incident(tx, ctx, ref) : { error: 'Hace falta el id' };
      case 'task':
        return byId ? this.task(tx, ctx, ref, tz) : { error: 'Hace falta el id' };
      case 'lead':
        return byId ? this.lead(tx, ref) : { error: 'Hace falta el id' };
      default:
        return { error: 'Tipo no válido' };
    }
  }

  private async customer(tx: Tx, ctx: Ctx, id: string) {
    const c = await tx.customer.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...CUSTOMER_NAME.select,
        email: true,
        phone: true,
        documentType: true,
        documentNumber: true,
        address: true,
        city: true,
        postalCode: true,
        tags: true,
        notes: true,
        kycVerified: true,
        depositExempt: true,
        portalLastSeenAt: true,
        marketingOptOutAt: true,
        locale: true,
        createdAt: true,
      },
    });
    if (!c) return { error: 'Inquilino no encontrado' };
    const contracts = await tx.contract.findMany({
      where: { customerId: id, deletedAt: null, ...contractScope(ctx.scope) },
      select: {
        id: true,
        contractNumber: true,
        status: true,
        startDate: true,
        endDate: true,
        priceMonthly: true,
        discountAmount: true,
        unit: { select: { code: true, facility: { select: { name: true } } } },
      },
      orderBy: { startDate: 'desc' },
      take: 10,
    });
    const [interactions, openIncidents] = await Promise.all([
      tx.customerInteraction.findMany({
        where: { customerId: id },
        select: { type: true, content: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
        take: 5,
      }),
      has(ctx, 'incidents:read')
        ? tx.incident.count({
            where: {
              customerId: id,
              deletedAt: null,
              status: { in: ['reported', 'investigating'] },
            },
          })
        : Promise.resolve(null),
    ]);
    const base = {
      id: c.id,
      name: personName(c),
      email: c.email,
      phone: c.phone,
      document: c.documentNumber ? `${c.documentType ?? ''} ${c.documentNumber}`.trim() : null,
      address: [c.address, c.postalCode, c.city].filter(Boolean).join(', ') || null,
      tags: c.tags,
      notes: c.notes,
      kycVerified: c.kycVerified,
      depositExempt: c.depositExempt,
      language: c.locale,
      customerSince: d(c.createdAt),
      lastSeenInPortal: d(c.portalLastSeenAt),
      unsubscribedFromMarketing: !!c.marketingOptOutAt,
      contracts: contracts.map((k) => ({
        id: k.id,
        number: k.contractNumber,
        status: k.status,
        unit: k.unit?.code ?? null,
        facility: k.unit?.facility?.name ?? null,
        start: d(k.startDate),
        end: d(k.endDate),
        monthlyPrice: r2(Number(k.priceMonthly) - Number(k.discountAmount)),
      })),
      recentNotes: interactions.map((i) => ({
        type: i.type,
        date: d(i.occurredAt),
        text: i.content.slice(0, 300),
      })),
      openIncidents,
    };
    if (!has(ctx, 'invoices:read')) {
      return { ...base, account: 'Sin permiso para ver facturas y cobros' };
    }
    const [invoices, payments, methods, mandate] = await Promise.all([
      tx.invoice.findMany({
        where: {
          customerId: id,
          deletedAt: null,
          kind: 'invoice',
          status: { in: ['issued', 'overdue'] },
          ...invoiceScope(ctx.scope),
        },
        select: { invoiceNumber: true, total: true, amountPaid: true, dueDate: true, status: true },
        orderBy: { dueDate: 'asc' },
      }),
      tx.payment.findMany({
        where: { customerId: id, status: { in: ['succeeded', 'partially_refunded', 'refunded'] } },
        select: { amount: true, refundedAmount: true, paidAt: true, methodType: true },
        orderBy: { paidAt: 'desc' },
        take: 5,
      }),
      tx.paymentMethod.findMany({
        where: { customerId: id, deletedAt: null },
        select: { type: true, brand: true, last4: true, isDefault: true, gateway: true },
      }),
      tx.sepaMandate.findFirst({
        where: { customerId: id, status: 'active' },
        select: { reference: true, ibanLast4: true, signatureStatus: true },
      }),
    ]);
    return {
      ...base,
      debt: r2(invoices.reduce((s, i) => s + pending(i), 0)),
      pendingInvoices: invoices.map((i) => ({
        number: i.invoiceNumber,
        status: i.status,
        pending: r2(pending(i)),
        dueDate: d(i.dueDate),
      })),
      lastPayments: payments.map((p) => ({
        date: d(p.paidAt),
        amount: r2(Number(p.amount) - Number(p.refundedAmount)),
        method: p.methodType,
      })),
      paymentMethods: methods.map((m) => ({
        type: m.type,
        brand: m.brand,
        last4: m.last4,
        default: m.isDefault,
        via: m.gateway,
      })),
      sepaMandate: mandate
        ? {
            reference: mandate.reference,
            account: `…${mandate.ibanLast4}`,
            signature: mandate.signatureStatus,
          }
        : null,
    };
  }

  private async contract(tx: Tx, ctx: Ctx, where: Prisma.ContractWhereInput) {
    const c = await tx.contract.findFirst({
      where: { ...where, deletedAt: null, ...contractScope(ctx.scope) },
      select: {
        id: true,
        contractNumber: true,
        status: true,
        startDate: true,
        endDate: true,
        signedAt: true,
        endingRequestedAt: true,
        priceMonthly: true,
        discountAmount: true,
        discountReason: true,
        discountExpiresAt: true,
        freeMonthsRemaining: true,
        billingIntervalMonths: true,
        billingStartsOn: true,
        prepayDiscountPct: true,
        firstPaymentMonths: true,
        depositAmount: true,
        depositStatus: true,
        depositReturnedAmount: true,
        depositPaymentMethod: true,
        insurancePrice: true,
        insurancePlan: { select: { name: true } },
        autoRenew: true,
        cancellationNoticeDays: true,
        irpfRetentionPct: true,
        preOpening: true,
        notes: true,
        customer: CUSTOMER_NAME,
        unit: {
          select: {
            id: true,
            code: true,
            areaM2: true,
            unitType: { select: { name: true } },
            facility: { select: { name: true } },
          },
        },
        events: {
          select: { eventType: true, occurredAt: true },
          orderBy: { occurredAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!c) return { error: 'Contrato no encontrado' };
    return {
      id: c.id,
      number: c.contractNumber,
      status: c.status,
      customer: { id: c.customer.id, name: personName(c.customer) },
      unit: {
        id: c.unit.id,
        code: c.unit.code,
        type: c.unit.unitType.name,
        m2: n(c.unit.areaM2),
        facility: c.unit.facility.name,
      },
      start: d(c.startDate),
      end: d(c.endDate),
      signed: d(c.signedAt),
      moveOutRequested: d(c.endingRequestedAt),
      monthlyPrice: n(c.priceMonthly),
      discount:
        Number(c.discountAmount) > 0
          ? { amount: n(c.discountAmount), reason: c.discountReason, until: d(c.discountExpiresAt) }
          : null,
      freeMonthsLeft: c.freeMonthsRemaining,
      billedEveryMonths: c.billingIntervalMonths,
      billingStartsOn: d(c.billingStartsOn),
      prepayDiscountPct: n(c.prepayDiscountPct),
      firstPaymentMonths: c.firstPaymentMonths,
      deposit: {
        amount: n(c.depositAmount),
        status: c.depositStatus,
        returned: n(c.depositReturnedAmount),
        paidBy: c.depositPaymentMethod,
      },
      insurance: c.insurancePlan
        ? { plan: c.insurancePlan.name, price: n(c.insurancePrice) }
        : null,
      autoRenew: c.autoRenew,
      noticeDays: c.cancellationNoticeDays,
      irpfRetentionPct: n(c.irpfRetentionPct),
      preOpening: c.preOpening,
      notes: c.notes,
      recentEvents: c.events.map((e) => ({ type: e.eventType, date: d(e.occurredAt) })),
    };
  }

  private async unit(tx: Tx, ctx: Ctx, where: Prisma.UnitWhereInput) {
    const u = await tx.unit.findFirst({
      where: { ...where, ...unitScope(ctx.scope) },
      select: {
        id: true,
        code: true,
        status: true,
        widthM: true,
        depthM: true,
        heightM: true,
        areaM2: true,
        basePriceMonthly: true,
        maintenanceUntil: true,
        notes: true,
        unitType: { select: { name: true, propertyKind: true } },
        facility: { select: { name: true } },
        floor: { select: { name: true } },
        contracts: {
          where: { deletedAt: null, status: { in: ['active', 'ending', 'draft'] } },
          select: {
            id: true,
            contractNumber: true,
            status: true,
            startDate: true,
            priceMonthly: true,
            customer: CUSTOMER_NAME,
          },
          take: 3,
        },
        statusHistory: {
          select: { previousStatus: true, newStatus: true, reason: true, occurredAt: true },
          orderBy: { occurredAt: 'desc' },
          take: 8,
        },
      },
    });
    if (!u) return { error: 'Trastero no encontrado' };
    return {
      id: u.id,
      code: u.code,
      status: u.status,
      facility: u.facility.name,
      floor: u.floor.name,
      type: u.unitType.name,
      kind: u.unitType.propertyKind,
      size: `${Number(u.widthM)} × ${Number(u.depthM)} × ${Number(u.heightM)} m`,
      m2: n(u.areaM2),
      listPrice: n(u.basePriceMonthly),
      maintenanceUntil: d(u.maintenanceUntil),
      notes: u.notes,
      contracts: u.contracts.map((c) => ({
        id: c.id,
        number: c.contractNumber,
        status: c.status,
        customer: personName(c.customer),
        since: d(c.startDate),
        price: n(c.priceMonthly),
      })),
      history: u.statusHistory.map((h) => ({
        date: d(h.occurredAt),
        from: h.previousStatus,
        to: h.newStatus,
        reason: h.reason,
      })),
    };
  }

  private async invoice(tx: Tx, ctx: Ctx, where: Prisma.InvoiceWhereInput) {
    const i = await tx.invoice.findFirst({
      where: { ...where, deletedAt: null, ...invoiceScope(ctx.scope) },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceType: true,
        kind: true,
        status: true,
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
        aeatStatus: true,
        notes: true,
        customer: CUSTOMER_NAME,
        contract: { select: { contractNumber: true } },
        items: {
          select: {
            description: true,
            quantity: true,
            unitPrice: true,
            taxRate: true,
            total: true,
          },
          orderBy: { position: 'asc' },
        },
        payments: {
          select: {
            amount: true,
            refundedAmount: true,
            status: true,
            methodType: true,
            paidAt: true,
            failureReason: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!i) return { error: 'Factura no encontrada' };
    return {
      id: i.id,
      number: i.invoiceNumber,
      type: i.invoiceType,
      kind: i.kind,
      status: i.status,
      customer: i.customer ? { id: i.customer.id, name: personName(i.customer) } : null,
      contract: i.contract?.contractNumber ?? null,
      issued: d(i.issueDate),
      due: d(i.dueDate),
      period: i.periodStart ? `${d(i.periodStart)} → ${d(i.periodEnd)}` : null,
      base: n(i.subtotal),
      vat: n(i.taxAmount),
      total: n(i.total),
      paid: n(i.amountPaid),
      refunded: n(i.amountRefunded),
      withholding: n(i.withholdingAmount),
      pending: r2(
        Math.max(0, Number(i.total) - Number(i.amountPaid) - Number(i.withholdingAmount)),
      ),
      aeat: i.aeatStatus,
      notes: i.notes,
      lines: i.items.map((l) => ({
        description: l.description,
        quantity: n(l.quantity),
        unitPrice: n(l.unitPrice),
        vatPct: n(l.taxRate),
        total: n(l.total),
      })),
      payments: i.payments.map((p) => ({
        date: d(p.paidAt ?? p.createdAt),
        amount: n(p.amount),
        refunded: n(p.refundedAmount),
        status: p.status,
        method: p.methodType,
        failure: p.failureReason,
      })),
    };
  }

  private async facility(tx: Tx, ctx: Ctx, where: Prisma.FacilityWhereInput) {
    const f = await tx.facility.findFirst({
      where: { ...where, deletedAt: null, ...(ctx.scope ? { id: { in: ctx.scope } } : {}) },
      select: {
        id: true,
        name: true,
        address: true,
        postalCode: true,
        city: true,
        contactPhone: true,
        contactEmail: true,
        timezone: true,
        openingHours: true,
        accessCurfewEnabled: true,
        accessCurfewStart: true,
        accessCurfewEnd: true,
        isActive: true,
        preOpening: true,
        openingDate: true,
        features: true,
        owner: { select: { legalName: true } },
      },
    });
    if (!f) return { error: 'Local no encontrado' };
    const [byStatus, types] = await Promise.all([
      tx.unit.groupBy({ by: ['status'], where: { facilityId: f.id }, _count: true }),
      tx.unit.groupBy({
        by: ['unitTypeId'],
        where: { facilityId: f.id, status: 'available' },
        _count: true,
        _min: { basePriceMonthly: true },
      }),
    ]);
    const names = await tx.unitType.findMany({
      where: { id: { in: types.map((t) => t.unitTypeId) } },
      select: { id: true, name: true },
    });
    const typeName = new Map(names.map((t) => [t.id, t.name]));
    return {
      id: f.id,
      name: f.name,
      address: [f.address, f.postalCode, f.city].filter(Boolean).join(', ') || null,
      phone: f.contactPhone,
      email: f.contactEmail,
      timezone: f.timezone,
      openingHours: f.openingHours,
      accessCurfew: f.accessCurfewEnabled ? `${f.accessCurfewStart} → ${f.accessCurfewEnd}` : null,
      active: f.isActive,
      preOpening: f.preOpening ? { openingDate: d(f.openingDate) } : null,
      features: f.features,
      owner: f.owner?.legalName ?? null,
      unitsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      availableByType: types.map((t) => ({
        type: typeName.get(t.unitTypeId) ?? null,
        available: t._count,
        priceFrom: n(t._min.basePriceMonthly),
      })),
    };
  }

  private async reservation(tx: Tx, ctx: Ctx, id: string) {
    const r = await tx.reservation.findFirst({
      where: { id, ...(ctx.scope ? { unit: { facilityId: { in: ctx.scope } } } : {}) },
      select: {
        status: true,
        validFrom: true,
        validUntil: true,
        depositAmount: true,
        depositPaid: true,
        notes: true,
        cancelReason: true,
        customer: CUSTOMER_NAME,
        unit: { select: { code: true, facility: { select: { name: true } } } },
      },
    });
    if (!r) return { error: 'Reserva no encontrada' };
    return {
      status: r.status,
      customer: personName(r.customer),
      unit: r.unit.code,
      facility: r.unit.facility.name,
      from: d(r.validFrom),
      until: d(r.validUntil),
      deposit: n(r.depositAmount),
      depositPaid: r.depositPaid,
      notes: r.notes,
      cancelReason: r.cancelReason,
    };
  }

  private async incident(tx: Tx, ctx: Ctx, id: string) {
    const i = await tx.incident.findFirst({
      where: { id, deletedAt: null, ...optionalScope(ctx.scope) },
      select: {
        title: true,
        description: true,
        status: true,
        severity: true,
        occurredAt: true,
        createdAt: true,
        resolution: true,
        reportedByExternal: true,
        customer: CUSTOMER_NAME,
        unit: { select: { code: true } },
        facility: { select: { name: true } },
        assignedTo: { select: { fullName: true } },
      },
    });
    if (!i) return { error: 'Incidencia no encontrada' };
    return {
      title: i.title,
      description: i.description,
      status: i.status,
      severity: i.severity,
      happened: d(i.occurredAt ?? i.createdAt),
      customer: personName(i.customer),
      unit: i.unit?.code ?? null,
      facility: i.facility?.name ?? null,
      assignedTo: i.assignedTo?.fullName ?? null,
      reportedBy: i.reportedByExternal,
      resolution: i.resolution,
    };
  }

  private async task(tx: Tx, ctx: Ctx, id: string, tz: string) {
    const t = await tx.task.findFirst({
      where: { id, deletedAt: null, ...optionalScope(ctx.scope) },
      select: {
        title: true,
        description: true,
        type: true,
        status: true,
        priority: true,
        dueDate: true,
        checklist: true,
        facility: { select: { name: true } },
        unit: { select: { code: true } },
        assignedTo: { select: { fullName: true } },
      },
    });
    if (!t) return { error: 'Tarea no encontrada' };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const due = d(t.dueDate);
    return {
      title: t.title,
      description: t.description,
      type: t.type,
      status: t.status,
      priority: t.priority,
      due,
      overdue: !!due && due < today && ['open', 'in_progress'].includes(t.status),
      facility: t.facility?.name ?? null,
      unit: t.unit?.code ?? null,
      assignedTo: t.assignedTo?.fullName ?? null,
      checklist: t.checklist,
    };
  }

  private async lead(tx: Tx, id: string) {
    const l = await tx.lead.findFirst({
      where: { id, deletedAt: null },
      select: {
        firstName: true,
        lastName: true,
        companyName: true,
        email: true,
        phone: true,
        status: true,
        source: true,
        message: true,
        lostReasonCode: true,
        createdAt: true,
        utmSource: true,
        utmCampaign: true,
        preferredFacility: { select: { name: true } },
        preferredUnitType: { select: { name: true } },
        assignedTo: { select: { fullName: true } },
        followups: {
          where: { status: 'pending' },
          select: { dueDate: true, note: true },
          take: 3,
        },
      },
    });
    if (!l) return { error: 'Contacto no encontrado' };
    return {
      name: personName(l),
      email: l.email,
      phone: l.phone,
      status: l.status,
      source: l.source,
      campaign: l.utmCampaign ?? l.utmSource,
      message: l.message?.slice(0, 500) ?? null,
      lostReason: l.lostReasonCode,
      created: d(l.createdAt),
      wantsFacility: l.preferredFacility?.name ?? null,
      wantsSize: l.preferredUnitType?.name ?? null,
      assignedTo: l.assignedTo?.fullName ?? null,
      pendingFollowups: l.followups.map((f) => ({ due: d(f.dueDate), note: f.note })),
    };
  }

  // ─── Listados ──────────────────────────────────────────────────────────────

  private async list(tx: Tx, ctx: Ctx, type: ListType, input: Input, tz: string) {
    const when = range(input, tz);
    const customerId = UUID.test(str(input.customerId)) ? str(input.customerId) : undefined;
    const facilityId = UUID.test(str(input.facilityId)) ? str(input.facilityId) : undefined;
    if (facilityId && ctx.scope && !ctx.scope.includes(facilityId)) {
      return { error: 'Ese local no está entre los que puedes ver' };
    }
    const status = str(input.status) || undefined;
    switch (type) {
      case 'invoices': {
        const st = pick(status, [
          'draft',
          'issued',
          'paid',
          'overdue',
          'cancelled',
          'refunded',
          'partially_refunded',
          'rectified',
        ] as const);
        const rows = await tx.invoice.findMany({
          where: {
            deletedAt: null,
            ...(st ? { status: st } : {}),
            ...(customerId ? { customerId } : {}),
            ...(when ? { issueDate: when } : {}),
            ...(facilityId ? { contract: { unit: { facilityId } } } : invoiceScope(ctx.scope)),
          },
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            kind: true,
            issueDate: true,
            dueDate: true,
            total: true,
            amountPaid: true,
            customer: CUSTOMER_NAME,
          },
          orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
          take: LIMIT,
        });
        return rows.map((i) => ({
          id: i.id,
          number: i.invoiceNumber,
          status: i.status,
          kind: i.kind,
          customer: personName(i.customer),
          issued: d(i.issueDate),
          due: d(i.dueDate),
          total: n(i.total),
          pending: r2(pending(i)),
        }));
      }
      case 'payments': {
        const st = pick(status, [
          'pending',
          'processing',
          'succeeded',
          'failed',
          'refunded',
          'partially_refunded',
        ] as const);
        const rows = await tx.payment.findMany({
          where: {
            ...(st ? { status: st } : {}),
            ...(customerId ? { customerId } : {}),
            ...(when ? { OR: [{ paidAt: when }, { paidAt: null, createdAt: when }] } : {}),
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
            ...(ctx.scope || facilityId
              ? {
                  invoice: facilityId
                    ? { contract: { unit: { facilityId } } }
                    : invoiceScope(ctx.scope),
                }
              : {}),
          },
          select: {
            amount: true,
            refundedAmount: true,
            status: true,
            methodType: true,
            gateway: true,
            paidAt: true,
            createdAt: true,
            failureReason: true,
            customer: CUSTOMER_NAME,
            invoice: { select: { invoiceNumber: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((p) => ({
          date: d(p.paidAt ?? p.createdAt),
          customer: personName(p.customer),
          invoice: p.invoice?.invoiceNumber ?? null,
          amount: n(p.amount),
          refunded: n(p.refundedAmount),
          status: p.status,
          method: p.methodType,
          via: p.gateway,
          failure: p.failureReason,
        }));
      }
      case 'contracts': {
        const st = pick(status, ['draft', 'active', 'ending', 'ended', 'cancelled'] as const);
        const rows = await tx.contract.findMany({
          where: {
            deletedAt: null,
            ...(st ? { status: st } : {}),
            ...(customerId ? { customerId } : {}),
            ...(when ? { startDate: when } : {}),
            ...(facilityId ? { unit: { facilityId } } : contractScope(ctx.scope)),
          },
          select: {
            id: true,
            contractNumber: true,
            status: true,
            startDate: true,
            endDate: true,
            priceMonthly: true,
            customer: CUSTOMER_NAME,
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
          orderBy: { startDate: 'desc' },
          take: LIMIT,
        });
        return rows.map((c) => ({
          id: c.id,
          number: c.contractNumber,
          status: c.status,
          customer: personName(c.customer),
          unit: c.unit.code,
          facility: c.unit.facility.name,
          start: d(c.startDate),
          end: d(c.endDate),
          price: n(c.priceMonthly),
        }));
      }
      case 'units': {
        const st = pick(status, [
          'available',
          'occupied',
          'reserved',
          'maintenance',
          'blocked',
        ] as const);
        const rows = await tx.unit.findMany({
          where: {
            ...(st ? { status: st } : {}),
            ...(facilityId ? { facilityId } : unitScope(ctx.scope)),
          },
          select: {
            id: true,
            code: true,
            status: true,
            areaM2: true,
            basePriceMonthly: true,
            unitType: { select: { name: true } },
            facility: { select: { name: true } },
          },
          orderBy: [{ facilityId: 'asc' }, { code: 'asc' }],
          take: LIMIT,
        });
        return rows.map((u) => ({
          id: u.id,
          code: u.code,
          status: u.status,
          type: u.unitType.name,
          m2: n(u.areaM2),
          price: n(u.basePriceMonthly),
          facility: u.facility.name,
        }));
      }
      case 'reservations': {
        const st = pick(status, [
          'pending',
          'confirmed',
          'expired',
          'converted',
          'cancelled',
        ] as const);
        const rows = await tx.reservation.findMany({
          where: {
            ...(st ? { status: st } : {}),
            ...(customerId ? { customerId } : {}),
            ...(when ? { validFrom: when } : {}),
            ...(facilityId
              ? { unit: { facilityId } }
              : ctx.scope
                ? { unit: { facilityId: { in: ctx.scope } } }
                : {}),
          },
          select: {
            id: true,
            status: true,
            validFrom: true,
            validUntil: true,
            customer: CUSTOMER_NAME,
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((r) => ({
          id: r.id,
          status: r.status,
          customer: personName(r.customer),
          unit: r.unit.code,
          facility: r.unit.facility.name,
          from: d(r.validFrom),
          until: d(r.validUntil),
        }));
      }
      case 'waitlist': {
        const rows = await tx.waitlistEntry.findMany({
          where: {
            ...(status ? { status } : {}),
            ...(facilityId ? { facilityId } : ctx.scope ? { facilityId: { in: ctx.scope } } : {}),
          },
          select: {
            contactName: true,
            contactEmail: true,
            contactPhone: true,
            status: true,
            createdAt: true,
            facility: { select: { name: true } },
            unitType: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
        });
        return rows.map((w) => ({
          name: w.contactName,
          email: w.contactEmail,
          phone: w.contactPhone,
          status: w.status,
          since: d(w.createdAt),
          facility: w.facility.name,
          size: w.unitType.name,
        }));
      }
      case 'access_logs': {
        const result = pick(status, [
          'allowed',
          'denied_invalid_credential',
          'denied_inactive_credential',
          'denied_outside_hours',
          'denied_wrong_facility',
          'denied_dunning',
          'denied_unknown',
          'error',
        ] as const);
        const rows = await tx.accessLog.findMany({
          where: {
            ...(result ? { result } : {}),
            ...(customerId ? { customerId } : {}),
            ...(when ? { occurredAt: when } : {}),
            ...(facilityId
              ? { device: { facilityId } }
              : ctx.scope
                ? { device: { facilityId: { in: ctx.scope } } }
                : {}),
          },
          select: {
            occurredAt: true,
            result: true,
            method: true,
            reason: true,
            customer: CUSTOMER_NAME,
            device: { select: { name: true, facility: { select: { name: true } } } },
          },
          orderBy: { occurredAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((a) => ({
          when: a.occurredAt.toISOString(),
          result: a.result,
          method: a.method,
          reason: a.reason,
          customer: personName(a.customer),
          door: a.device?.name ?? null,
          facility: a.device?.facility?.name ?? null,
        }));
      }
      case 'leads': {
        const st = pick(status, ['new', 'contacted', 'qualified', 'won', 'lost'] as const);
        const rows = await tx.lead.findMany({
          where: {
            deletedAt: null,
            ...(st ? { status: st } : {}),
            ...(when ? { createdAt: when } : {}),
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
            status: true,
            source: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((l) => ({
          id: l.id,
          name: personName(l),
          email: l.email,
          phone: l.phone,
          status: l.status,
          source: l.source,
          created: d(l.createdAt),
        }));
      }
      case 'tasks': {
        const st = pick(status, ['open', 'in_progress', 'done', 'cancelled'] as const);
        const rows = await tx.task.findMany({
          where: {
            deletedAt: null,
            ...(st ? { status: st } : { status: { in: ['open', 'in_progress'] } }),
            ...(when ? { dueDate: when } : {}),
            ...(facilityId ? { facilityId } : optionalScope(ctx.scope)),
          },
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            dueDate: true,
            assignedTo: { select: { fullName: true } },
            facility: { select: { name: true } },
          },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
          take: LIMIT,
        });
        return rows.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          due: d(t.dueDate),
          assignedTo: t.assignedTo?.fullName ?? null,
          facility: t.facility?.name ?? null,
        }));
      }
      case 'incidents': {
        const st = pick(status, ['reported', 'investigating', 'resolved', 'dismissed'] as const);
        const rows = await tx.incident.findMany({
          where: {
            deletedAt: null,
            ...(st ? { status: st } : {}),
            ...(customerId ? { customerId } : {}),
            ...(when ? { createdAt: when } : {}),
            ...(facilityId ? { facilityId } : optionalScope(ctx.scope)),
          },
          select: {
            id: true,
            title: true,
            status: true,
            severity: true,
            createdAt: true,
            facility: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          severity: i.severity,
          date: d(i.createdAt),
          facility: i.facility?.name ?? null,
        }));
      }
      case 'expenses': {
        const from = day(input.from);
        const to = day(input.to);
        const rows = await tx.expense.findMany({
          where: {
            ...(from || to
              ? {
                  expenseDate: {
                    ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
                    ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}),
                  },
                }
              : {}),
            ...(status ? { category: status } : {}),
            ...(facilityId ? { facilityId } : optionalScope(ctx.scope)),
          },
          select: {
            description: true,
            category: true,
            amount: true,
            expenseDate: true,
            vendor: true,
            facility: { select: { name: true } },
          },
          orderBy: { expenseDate: 'desc' },
          take: LIMIT,
        });
        return rows.map((e) => ({
          date: d(e.expenseDate),
          description: e.description,
          category: e.category,
          amount: n(e.amount),
          vendor: e.vendor,
          facility: e.facility?.name ?? 'General',
        }));
      }
      case 'communications': {
        const commStatus = pick(status, [
          'pending',
          'processing',
          'sent',
          'delivered',
          'failed',
          'bounced',
          'skipped',
        ] as const);
        const rows = await tx.communication.findMany({
          where: {
            ...(customerId ? { customerId } : {}),
            ...(when ? { createdAt: when } : {}),
            ...(commStatus ? { status: commStatus } : {}),
          },
          select: {
            channel: true,
            status: true,
            recipient: true,
            subject: true,
            source: true,
            errorMessage: true,
            createdAt: true,
            customer: CUSTOMER_NAME,
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((c) => ({
          date: d(c.createdAt),
          channel: c.channel,
          status: c.status,
          to: personName(c.customer) ?? c.recipient,
          subject: c.subject,
          source: c.source,
          error: c.errorMessage,
        }));
      }
      case 'campaigns': {
        const rows = await tx.campaign.findMany({
          where: status ? { status } : {},
          select: {
            name: true,
            status: true,
            channel: true,
            audienceCount: true,
            sentCount: true,
            sentAt: true,
            scheduledFor: true,
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((c) => ({
          name: c.name,
          status: c.status,
          channel: c.channel,
          audience: c.audienceCount,
          sent: c.sentCount,
          sentAt: d(c.sentAt),
          scheduledFor: d(c.scheduledFor),
        }));
      }
      case 'reminders': {
        const rows = await tx.businessReminder.findMany({
          where: {
            ...(status ? { status } : { status: { not: 'done' } }),
            ...(when ? { dueDate: when } : {}),
            ...(facilityId ? { facilityId } : optionalScope(ctx.scope)),
          },
          select: {
            title: true,
            category: true,
            dueDate: true,
            status: true,
            amount: true,
            vendor: true,
            recurrence: true,
          },
          orderBy: { dueDate: 'asc' },
          take: LIMIT,
        });
        return rows.map((r) => ({
          title: r.title,
          category: r.category,
          due: d(r.dueDate),
          status: r.status,
          amount: n(r.amount),
          vendor: r.vendor,
          repeats: r.recurrence,
        }));
      }
      case 'coupons': {
        const rows = await tx.coupon.findMany({
          where: status === 'inactive' ? { isActive: false } : status ? {} : { isActive: true },
          select: {
            code: true,
            name: true,
            discountType: true,
            discountValue: true,
            minMonths: true,
            newCustomersOnly: true,
            maxUses: true,
            usedCount: true,
            validFrom: true,
            validUntil: true,
            isActive: true,
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((c) => ({
          code: c.code,
          name: c.name,
          type: c.discountType,
          value: n(c.discountValue),
          minMonths: c.minMonths,
          newCustomersOnly: c.newCustomersOnly,
          uses: `${c.usedCount}${c.maxUses != null ? `/${c.maxUses}` : ''}`,
          from: d(c.validFrom),
          until: d(c.validUntil),
          active: c.isActive,
        }));
      }
      case 'promotions': {
        const rows = await tx.promotion.findMany({
          where: status === 'inactive' ? { isActive: false } : status ? {} : { isActive: true },
          select: {
            code: true,
            name: true,
            discountType: true,
            discountValue: true,
            maxUses: true,
            usedCount: true,
            validFrom: true,
            validUntil: true,
            isActive: true,
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((p) => ({
          code: p.code,
          name: p.name,
          type: p.discountType,
          value: n(p.discountValue),
          uses: `${p.usedCount}${p.maxUses != null ? `/${p.maxUses}` : ''}`,
          from: d(p.validFrom),
          until: d(p.validUntil),
          active: p.isActive,
        }));
      }
      case 'reviews': {
        const rows = await tx.review.findMany({
          where: {
            ...(status ? { status } : { status: 'submitted' }),
            ...(customerId ? { customerId } : {}),
            ...(when ? { createdAt: when } : {}),
          },
          select: {
            status: true,
            npsScore: true,
            rating: true,
            comment: true,
            createdAt: true,
            customer: CUSTOMER_NAME,
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((r) => ({
          date: d(r.createdAt),
          customer: personName(r.customer),
          status: r.status,
          nps: r.npsScore,
          stars: r.rating,
          comment: r.comment?.slice(0, 300) ?? null,
        }));
      }
      case 'unit_change_requests': {
        const rows = await tx.unitChangeRequest.findMany({
          where: {
            ...(status ? { status } : { status: 'pending' }),
            ...(customerId ? { customerId } : {}),
            ...(ctx.scope
              ? {
                  OR: [
                    { contract: { unit: { facilityId: { in: ctx.scope } } } },
                    { contractId: null },
                  ],
                }
              : {}),
          },
          select: {
            status: true,
            note: true,
            desiredDate: true,
            createdAt: true,
            resolutionNote: true,
            customer: CUSTOMER_NAME,
            contract: { select: { unit: { select: { code: true } } } },
            targetUnit: { select: { code: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((u) => ({
          date: d(u.createdAt),
          customer: personName(u.customer),
          from: u.contract?.unit.code ?? null,
          wants: u.targetUnit?.code ?? null,
          desiredDate: d(u.desiredDate),
          note: u.note,
          status: u.status,
          resolution: u.resolutionNote,
        }));
      }
      case 'payment_plans': {
        const rows = await tx.paymentPlan.findMany({
          where: {
            ...(status ? { status } : { status: 'active' }),
            ...(customerId ? { customerId } : {}),
          },
          select: {
            status: true,
            totalAmount: true,
            paidAtStart: true,
            installments: true,
            createdAt: true,
            customer: CUSTOMER_NAME,
          },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        });
        return rows.map((p) => ({
          customer: personName(p.customer),
          status: p.status,
          total: n(p.totalAmount),
          paidAtStart: n(p.paidAtStart),
          installments: p.installments,
          created: d(p.createdAt),
        }));
      }
      default:
        return { error: 'Tipo no válido' };
    }
  }

  // ─── Negocio ───────────────────────────────────────────────────────────────

  private async collectionsMonth(tx: Tx, ctx: Ctx, monthInput: string, tz: string) {
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const month = /^\d{4}-\d{2}$/.test(monthInput) ? monthInput : now.slice(0, 7);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const first = `${month}-01`;
    const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const start = zonedDayStart(first, tz);
    const end = zonedDayStart(next, tz);
    const dueRange = { gte: new Date(`${first}T00:00:00Z`), lt: new Date(`${next}T00:00:00Z`) };
    const [due, collected] = await Promise.all([
      tx.invoice.findMany({
        where: {
          deletedAt: null,
          kind: 'invoice',
          status: { in: ['issued', 'overdue', 'paid'] },
          dueDate: dueRange,
          ...invoiceScope(ctx.scope),
        },
        select: { total: true, amountPaid: true, status: true, withholdingAmount: true },
      }),
      tx.payment.findMany({
        where: {
          status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
          paidAt: { gte: start, lt: end },
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          ...(ctx.scope ? { invoice: invoiceScope(ctx.scope) } : {}),
        },
        select: { amount: true, refundedAmount: true, methodType: true },
      }),
    ]);
    const byMethod = new Map<string, number>();
    for (const p of collected) {
      const v = Number(p.amount) - Number(p.refundedAmount);
      byMethod.set(p.methodType, (byMethod.get(p.methodType) ?? 0) + v);
    }
    const expected = due.reduce((s, i) => s + Number(i.total) - Number(i.withholdingAmount), 0);
    const stillPending = due.filter((i) => i.status !== 'paid').reduce((s, i) => s + pending(i), 0);
    return {
      month,
      expectedFromInvoicesDueThisMonth: r2(expected),
      stillPending: r2(stillPending),
      overdueInvoices: due.filter((i) => i.status === 'overdue').length,
      collectedThisMonth: r2([...byMethod.values()].reduce((s, v) => s + v, 0)),
      collectedByMethod: Object.fromEntries([...byMethod].map(([k, v]) => [k, r2(v)])),
      note: 'Lo cobrado incluye cobros de facturas de otros meses.',
    };
  }

  private async debtors(tx: Tx, ctx: Ctx) {
    const rows = await tx.invoice.findMany({
      where: {
        deletedAt: null,
        kind: 'invoice',
        status: 'overdue',
        customerId: { not: null },
        ...invoiceScope(ctx.scope),
      },
      select: {
        total: true,
        amountPaid: true,
        dueDate: true,
        customer: { select: { ...CUSTOMER_NAME.select, phone: true, email: true } },
      },
    });
    const by = new Map<
      string,
      {
        name: string | null;
        phone: string | null;
        email: string | null;
        debt: number;
        invoices: number;
        oldest: Date | null;
      }
    >();
    for (const i of rows) {
      if (!i.customer) continue;
      const cur = by.get(i.customer.id) ?? {
        name: personName(i.customer),
        phone: i.customer.phone,
        email: i.customer.email,
        debt: 0,
        invoices: 0,
        oldest: null,
      };
      cur.debt += pending(i);
      cur.invoices += 1;
      if (i.dueDate && (!cur.oldest || i.dueDate < cur.oldest)) cur.oldest = i.dueDate;
      by.set(i.customer.id, cur);
    }
    const today = Date.now();
    return [...by.entries()]
      .map(([id, v]) => ({
        customerId: id,
        name: v.name,
        phone: v.phone,
        email: v.email,
        debt: r2(v.debt),
        invoices: v.invoices,
        oldestDue: d(v.oldest),
        daysLate: v.oldest ? Math.floor((today - v.oldest.getTime()) / 86_400_000) : null,
      }))
      .sort((a, b) => b.debt - a.debt)
      .slice(0, LIMIT);
  }

  private async calendar(tx: Tx, ctx: Ctx, input: Input, tz: string) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const from = day(input.from) ?? today;
    const fallbackTo = new Date(`${from}T00:00:00Z`);
    fallbackTo.setUTCDate(fallbackTo.getUTCDate() + 7);
    const to = day(input.to) ?? fallbackTo.toISOString().slice(0, 10);
    const dates = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) };
    const [starts, ends, reservations, tasks, reminders] = await Promise.all([
      tx.contract.findMany({
        where: {
          deletedAt: null,
          status: { in: ['active', 'ending', 'draft'] },
          startDate: dates,
          ...contractScope(ctx.scope),
        },
        select: {
          contractNumber: true,
          startDate: true,
          customer: CUSTOMER_NAME,
          unit: { select: { code: true } },
        },
        take: LIMIT,
      }),
      tx.contract.findMany({
        where: {
          deletedAt: null,
          status: { in: ['active', 'ending'] },
          endDate: dates,
          ...contractScope(ctx.scope),
        },
        select: {
          contractNumber: true,
          endDate: true,
          autoRenew: true,
          status: true,
          customer: CUSTOMER_NAME,
          unit: { select: { code: true } },
        },
        take: LIMIT,
      }),
      has(ctx, 'reservations:read')
        ? tx.reservation.findMany({
            where: {
              status: { in: ['pending', 'confirmed'] },
              OR: [{ validFrom: dates }, { validUntil: dates }],
              ...(ctx.scope ? { unit: { facilityId: { in: ctx.scope } } } : {}),
            },
            select: {
              status: true,
              validFrom: true,
              validUntil: true,
              customer: CUSTOMER_NAME,
              unit: { select: { code: true } },
            },
            take: LIMIT,
          })
        : Promise.resolve([]),
      has(ctx, 'tasks:read')
        ? tx.task.findMany({
            where: {
              deletedAt: null,
              status: { in: ['open', 'in_progress'] },
              dueDate: dates,
              ...optionalScope(ctx.scope),
            },
            select: { title: true, dueDate: true, priority: true },
            take: LIMIT,
          })
        : Promise.resolve([]),
      has(ctx, 'reminders:read')
        ? tx.businessReminder.findMany({
            where: { status: { not: 'done' }, dueDate: dates, ...optionalScope(ctx.scope) },
            select: { title: true, dueDate: true, amount: true },
            take: LIMIT,
          })
        : Promise.resolve([]),
    ]);
    return {
      from,
      to,
      moveIns: starts.map((c) => ({
        date: d(c.startDate),
        contract: c.contractNumber,
        customer: personName(c.customer),
        unit: c.unit.code,
      })),
      contractsEnding: ends.map((c) => ({
        date: d(c.endDate),
        contract: c.contractNumber,
        customer: personName(c.customer),
        unit: c.unit.code,
        renewsAutomatically: c.autoRenew && c.status === 'active',
        moveOutRequested: c.status === 'ending',
      })),
      reservations: reservations.map((r) => ({
        status: r.status,
        from: d(r.validFrom),
        until: d(r.validUntil),
        customer: personName(r.customer),
        unit: r.unit.code,
      })),
      tasks: tasks.map((t) => ({ date: d(t.dueDate), title: t.title, priority: t.priority })),
      reminders: reminders.map((r) => ({
        date: d(r.dueDate),
        title: r.title,
        amount: n(r.amount),
      })),
    };
  }

  private async settings(tx: Tx, ctx: Ctx) {
    const [tenant, facilities, types, insurance, redsys, sepa, gocardless, stripe] =
      await Promise.all([
        tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: {
            name: true,
            billingLegalName: true,
            taxId: true,
            timezone: true,
            invoicingMode: true,
            autoChargeOnIssue: true,
            autoChargeRetryEnabled: true,
            lateFeeEnabled: true,
            lateFeeType: true,
            lateFeeValue: true,
            lateFeeGraceDays: true,
            transferIban: true,
            offlineTransferEnabled: true,
            offlineCashEnabled: true,
            offlineSepaEnabled: true,
            nightPassEnabled: true,
            nightPassPrice: true,
            extraAccessLimit: true,
            firstPaymentNextMonthFromDay: true,
            autoEndContracts: true,
          },
        }),
        tx.facility.findMany({
          where: { deletedAt: null, ...(ctx.scope ? { id: { in: ctx.scope } } : {}) },
          select: {
            name: true,
            address: true,
            city: true,
            contactPhone: true,
            contactEmail: true,
            openingHours: true,
            accessCurfewEnabled: true,
            accessCurfewStart: true,
            accessCurfewEnd: true,
            isActive: true,
            preOpening: true,
          },
        }),
        tx.unitType.findMany({
          where: { isActive: true },
          select: {
            name: true,
            defaultPriceMonthly: true,
            defaultDepositAmount: true,
            propertyKind: true,
            description: true,
          },
        }),
        tx.insurancePlan.findMany({
          where: { isActive: true },
          select: { name: true, monthlyPrice: true, coverageAmount: true },
        }),
        tx.redsysSettings.findFirst({ select: { enabled: true, bizumEnabled: true } }),
        tx.sepaSettings.findFirst({ select: { enabled: true } }),
        tx.goCardlessSettings.findFirst({ select: { enabled: true } }),
        tx.tenantStripeAccount.findFirst({ select: { chargesEnabled: true } }),
      ]);
    return {
      business: tenant?.name ?? null,
      legalName: tenant?.billingLegalName ?? null,
      taxId: tenant?.taxId ?? null,
      timezone: tenant?.timezone ?? null,
      facilities: facilities.map((f) => ({
        name: f.name,
        address: [f.address, f.city].filter(Boolean).join(', ') || null,
        phone: f.contactPhone,
        email: f.contactEmail,
        openingHours: f.openingHours,
        accessCurfew: f.accessCurfewEnabled
          ? `${f.accessCurfewStart} → ${f.accessCurfewEnd}`
          : null,
        active: f.isActive,
        preOpening: f.preOpening,
      })),
      unitTypes: types.map((t) => ({
        name: t.name,
        price: n(t.defaultPriceMonthly),
        deposit: n(t.defaultDepositAmount),
        kind: t.propertyKind,
        description: t.description,
      })),
      insurancePlans: insurance.map((i) => ({
        name: i.name,
        monthly: n(i.monthlyPrice),
        coverage: n(i.coverageAmount),
      })),
      payments: {
        cardByRedsys: !!redsys?.enabled,
        bizum: !!redsys?.bizumEnabled,
        cardByStripe: !!stripe?.chargesEnabled,
        sepaRemittances: !!sepa?.enabled,
        goCardless: !!gocardless?.enabled,
        bankTransfer: !!tenant?.transferIban,
        tenantCanChoose: {
          transfer: !!tenant?.offlineTransferEnabled,
          cashAtFacility: !!tenant?.offlineCashEnabled,
          directDebit: !!tenant?.offlineSepaEnabled,
        },
        autoChargeOnIssue: !!tenant?.autoChargeOnIssue,
        retries: !!tenant?.autoChargeRetryEnabled,
      },
      billing: {
        invoicesIssuedIn: tenant?.invoicingMode ?? null,
        lateFee: tenant?.lateFeeEnabled
          ? `${n(tenant.lateFeeValue)}${tenant.lateFeeType === 'percentage' ? ' %' : ' €'} a los ${tenant.lateFeeGraceDays} días`
          : null,
        firstPaymentIncludesNextMonthFromDay: tenant?.firstPaymentNextMonthFromDay ?? null,
        autoEndContracts: tenant?.autoEndContracts ?? null,
      },
      access: {
        nightPass: tenant?.nightPassEnabled ? n(tenant.nightPassPrice) : null,
        extraAccessesPerTenant: tenant?.extraAccessLimit ?? null,
      },
    };
  }

  private async trend(tx: Tx, ctx: Ctx, monthsInput: unknown) {
    const parsed = Number.parseInt(String(monthsInput ?? ''), 10);
    const months = Number.isFinite(parsed) ? Math.min(24, Math.max(1, parsed)) : 12;
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const contracts = await tx.contract.findMany({
      where: {
        deletedAt: null,
        signedAt: { not: null },
        ...contractScope(ctx.scope),
        OR: [{ endedAt: null }, { endedAt: { gte: first } }, { cancelledAt: { gte: first } }],
      },
      select: { signedAt: true, startDate: true, endedAt: true, cancelledAt: true, status: true },
    });
    const out: { month: string; signed: number; ended: number; liveAtMonthEnd: number }[] = [];
    for (let i = 0; i < months; i++) {
      const s = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
      const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
      let signed = 0;
      let ended = 0;
      let live = 0;
      for (const c of contracts) {
        const stop = c.endedAt ?? (c.status === 'cancelled' ? c.cancelledAt : null);
        if (c.signedAt && c.signedAt >= s && c.signedAt < e) signed++;
        if (stop && stop >= s && stop < e) ended++;
        if (c.signedAt && c.signedAt < e && (!stop || stop >= e)) live++;
      }
      out.push({ month: s.toISOString().slice(0, 7), signed, ended, liveAtMonthEnd: live });
    }
    return { months: out };
  }
}
