import { createHash, randomBytes, randomInt } from 'node:crypto';

import { DEMO_PORTAL_CUSTOMER_TAG, STAFF_EMAIL_KINDS } from '@storageos/shared';

import {
  clearDemoCatalog,
  restoreDemoConfig,
  seedAutomations,
  seedBlog,
  seedCashClosure,
  seedChannels,
  seedCollectionsCase,
  seedCoupon,
  seedFaq,
  seedMaintenancePlans,
  seedNightPasses,
  seedReferrals,
  seedWebVisits,
} from './sales-demo-extras';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { Logger } from '@nestjs/common';
import type { Prisma } from '@storageos/database';

/**
 * Datos de ejemplo de la cuenta de demostración: un poco de todo para que cada
 * pantalla tenga algo que enseñar (facturas pagadas, pendientes y vencidas,
 * cobros, contratos en marcha, con baja pedida y terminados, contactos,
 * reservas, lista de espera, tareas, incidencias, gastos, accesos,
 * valoraciones, mensajes y competencia).
 *
 * Se escribe directamente en la base de datos (sin eventos ni correos). Lo que
 * el vaciado conserva (contactos, competencia, productos, planes de seguro,
 * promociones y dispositivos) se crea una sola vez o se marca para poder
 * rehacerlo sin duplicar.
 */

const DAY = 86_400_000;
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

const FIRST_NAMES = [
  'Lucía',
  'Hugo',
  'Martina',
  'Mateo',
  'Sofía',
  'Leo',
  'Julia',
  'Daniel',
  'Paula',
  'Pablo',
  'Valeria',
  'Álvaro',
  'Carmen',
  'Adrián',
  'Elena',
  'Javier',
  'Sara',
  'Diego',
  'Noa',
  'Marcos',
  'Irene',
  'Sergio',
  'Claudia',
  'Raúl',
  'Alba',
  'Iván',
  'Marta',
  'Óscar',
  'Nerea',
  'Rubén',
];
const LAST_NAMES = [
  'García',
  'Martínez',
  'López',
  'Sánchez',
  'Pérez',
  'Gómez',
  'Martín',
  'Jiménez',
  'Ruiz',
  'Hernández',
  'Díaz',
  'Moreno',
  'Muñoz',
  'Álvarez',
  'Romero',
  'Alonso',
  'Gutiérrez',
  'Navarro',
  'Torres',
  'Domínguez',
  'Vázquez',
  'Ramos',
  'Gil',
  'Serrano',
  'Blanco',
  'Molina',
  'Castro',
];
const COMPANIES = [
  'Reformas Levante SL',
  'Mudanzas Rápidas SL',
  'Electro Hogar Valencia',
  'Archivo Legal Abogados',
  'Distribuciones Turia SL',
  'Floristería Las Flores',
];
const STREETS = [
  'Calle de Cuba',
  'Avenida del Puerto',
  'Calle de Sueca',
  'Gran Vía Fernando el Católico',
  'Calle de Alboraya',
  'Avenida de Aragón',
  'Calle de Jesús',
  'Avenida Blasco Ibáñez',
];

/** Tipo de dato `Decimal` de Prisma como número. */
const num = (v: unknown): number => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)]!;
const chance = (p: number) => Math.random() < p;

function dni(): string {
  const n = randomInt(10_000_000, 99_999_999);
  return `${n}${DNI_LETTERS[n % 23]}`;
}

/** Correo de ejemplo (dominio reservado: nunca llega a nadie). */
function demoEmail(first: string, last: string, n: number): string {
  const clean = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
  return `${clean(first)}.${clean(last.split(' ')[0] ?? '')}${n}@example.com`;
}

/** Día (00:00 UTC) de una fecha. */
function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Tamaño que la demo tiene siempre agotado en un local (con lista de espera). */
const SOLD_OUT = { facility: 'Norte', type: 'Grande' };

type PayMethod = 'card' | 'sepa_debit' | 'bank_transfer' | 'cash';
/** Cómo paga cada inquilino y si se retrasa. */
type Profile = 'good' | 'late' | 'debtor';

interface SeededContract {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  customerTaxId: string;
  unitId: string;
  unitCode: string;
  facilityId: string;
  price: number;
  deposit: number;
  insurance: { name: string; price: number } | null;
  start: Date;
  end: Date | null;
  status: 'active' | 'ending' | 'ended';
  profile: Profile;
  method: PayMethod;
  /** La inquilina con la que se entra al área de clientes. */
  portal: boolean;
}

/** Factura vencida sin cobrar (para el escalado de impagos). */
interface OverdueInvoice {
  invoiceId: string;
  customerId: string;
  dueDate: Date;
}

interface DraftInvoice {
  contract: SeededContract;
  issueDate: Date;
  dueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  label: string;
}

export interface DemoSeedContext {
  db: PrismaAdminService;
  tenantId: string;
  logger: Logger;
  occupancy: number;
  /** Cifra el PIN para que la inquilina lo vea en su área de clientes. */
  encryptSecret?: (plain: string) => string;
}

/** Siembra todo lo de la demo. Cada parte que falla se anota y no para el resto. */
export async function seedDemoData(ctx: DemoSeedContext): Promise<void> {
  const { db, tenantId, logger } = ctx;
  usedNames.clear();
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      logger.warn(`[sales] demo ${tenantId}: no se ha podido crear «${name}»: ${String(err)}`);
    }
  };

  const owner = await db.user.findFirst({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const ownerId = owner?.id ?? null;
  const facilities = await db.facility.findMany({
    where: { tenantId, deletedAt: null, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const types = await db.unitType.findMany({
    where: { tenantId },
    select: { id: true, name: true, defaultDepositAmount: true },
  });

  // Puesta en marcha completa: cobra por transferencia y en el local, y emite
  // solas las facturas de cada mes.
  await step('ajustes de cobro', async () => {
    await db.tenant.update({
      where: { id: tenantId },
      data: {
        transferIban: 'ES9121000418450200051332',
        offlineCashEnabled: true,
        offlineTransferEnabled: true,
        // Lo ve el cliente en la web y en el contrato: nunca el correo real
        // de quien creó la demo.
        contactEmail: 'hola@example.com',
        contactPhone: '960 000 000',
        autoIssueRecurring: true,
        // El resumen mensual de marketing iría al correo real de quien creó la demo.
        marketingReportEnabled: false,
        // Los avisos al equipo irían al correo real de quien creó la demo.
        staffEmailSettings: Object.fromEntries(STAFF_EMAIL_KINDS.map((k) => [k, false])),
      },
    });
  });

  // La configuración y el catálogo vuelven a como eran: lo que un comercial
  // cambie en una demo no pasa a la siguiente.
  await step('configuración', () => restoreDemoConfig(db, tenantId));
  await step('catálogo', () => clearDemoCatalog(db, tenantId));
  await step('preguntas frecuentes', () => seedFaq(db, tenantId));
  await step('blog', () => seedBlog(db, tenantId));
  await step('cupón', () => seedCoupon(db, tenantId));
  await step('canales de marketing', () => seedChannels(db, tenantId, facilities));
  await step('automatizaciones', () => seedAutomations(db, tenantId));
  await step('mantenimiento', () => seedMaintenancePlans(db, tenantId, facilities, ownerId));
  await step('visitas de la web', () => seedWebVisits(db, tenantId));

  let insurancePlan: { id: string; name: string; price: number } | null = null;
  await step('plan de seguro', async () => {
    insurancePlan = await ensureInsurancePlan(db, tenantId);
  });
  await step('productos', () => ensureProducts(db, tenantId, facilities));
  await step('promoción', () => ensurePromotion(db, tenantId));

  let contracts: SeededContract[] = [];
  await step('inquilinos y contratos', async () => {
    contracts = await seedContracts(db, tenantId, types, insurancePlan, ctx.occupancy);
  });
  let overdue: OverdueInvoice[] = [];
  await step('facturas y cobros', async () => {
    overdue = await seedInvoices(db, tenantId, contracts);
  });
  // Inquilino → factura por la que se le cortó el acceso.
  const cuts = new Map<string, string>();
  await step('escalado de impagos', async () => {
    for (const [k, v] of await seedDunning(db, tenantId, overdue)) cuts.set(k, v);
  });
  await step('trasteros fuera de servicio', () => seedUnitStates(db, tenantId));
  await step('reservas y lista de espera', () => seedReservations(db, tenantId, types, facilities));
  await step('contactos', () => seedLeads(db, tenantId, ownerId, types, facilities, contracts));
  await step('tareas e incidencias', () => seedOperations(db, tenantId, ownerId, contracts));
  await step('gastos', () => seedExpenses(db, tenantId, facilities));
  await step('accesos', () => seedAccess(db, tenantId, facilities, contracts, cuts));
  await step('valoraciones', () => seedReviews(db, tenantId, contracts));
  await step('mensajes y avisos', () => seedMessages(db, tenantId, ownerId, contracts));
  await step('competencia', () => ensureCompetitors(db, tenantId, facilities));
  await step('inquilina del área de clientes', () =>
    seedPortalCustomer(db, tenantId, ownerId, contracts, ctx.encryptSecret),
  );
  await step('referidos', () => seedReferrals(db, tenantId, contracts));
  await step('expediente de impago', () =>
    seedCollectionsCase(db, tenantId, contracts, cuts, ownerId),
  );
  await step('pases nocturnos', () => seedNightPasses(db, tenantId, contracts, facilities));
  await step('cierre de caja', () => seedCashClosure(db, tenantId, ownerId));
}

// --------------------------------------------------------------- estructura

async function ensureInsurancePlan(
  db: PrismaAdminService,
  tenantId: string,
): Promise<{ id: string; name: string; price: number }> {
  const name = 'Protección básica';
  const found = await db.insurancePlan.findFirst({ where: { tenantId, name } });
  const plan =
    found ??
    (await db.insurancePlan.create({
      data: {
        tenantId,
        name,
        monthlyPrice: 4.5,
        coverageAmount: 3000,
        description: 'Cubre robo, incendio y daños por agua hasta 3.000 €.',
      },
    }));
  return { id: plan.id, name: plan.name, price: num(plan.monthlyPrice) };
}

async function ensureProducts(
  db: PrismaAdminService,
  tenantId: string,
  facilities: { id: string }[],
): Promise<void> {
  const products = [
    {
      sku: 'DEMO-CANDADO',
      name: 'Candado de disco',
      type: 'lock' as const,
      price: 12.9,
      min: 5,
      stock: [14, 4],
    },
    {
      sku: 'DEMO-CAJA-L',
      name: 'Caja de cartón grande',
      type: 'box' as const,
      price: 3.5,
      min: 20,
      stock: [60, 45],
    },
    {
      sku: 'DEMO-CINTA',
      name: 'Cinta de embalar',
      type: 'packaging' as const,
      price: 2.95,
      min: 10,
      stock: [30, 22],
    },
    {
      sku: 'DEMO-PLASTICO',
      name: 'Rollo de plástico de burbujas',
      type: 'packaging' as const,
      price: 8.5,
      min: 5,
      stock: [9, 12],
    },
  ];
  for (const p of products) {
    const product = await db.product.upsert({
      where: { tenantId_sku: { tenantId, sku: p.sku } },
      create: { tenantId, sku: p.sku, name: p.name, type: p.type, price: p.price, minStock: p.min },
      update: { isActive: true, deletedAt: null },
    });
    for (const [i, f] of facilities.entries()) {
      const quantity = p.stock[i] ?? 10;
      await db.productStock.upsert({
        where: { productId_facilityId: { productId: product.id, facilityId: f.id } },
        create: { tenantId, productId: product.id, facilityId: f.id, quantity },
        update: { quantity },
      });
    }
  }
}

async function ensurePromotion(db: PrismaAdminService, tenantId: string): Promise<void> {
  const code = 'BIENVENIDA10';
  const found = await db.promotion.findFirst({ where: { tenantId, code } });
  if (found) return;
  await db.promotion.create({
    data: {
      tenantId,
      code,
      name: '10 % los tres primeros meses',
      discountType: 'percentage',
      discountValue: 10,
      durationMonths: 3,
      newCustomersOnly: true,
      announceOnWeb: true,
    },
  });
}

// --------------------------------------------------- inquilinos y contratos

/** Nombres ya usados en este sembrado: no se repiten inquilinos ni empresas. */
const usedNames = new Set<string>();

function freshName(make: () => string): string | null {
  for (let i = 0; i < 30; i++) {
    const name = make();
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  return null;
}

async function newCustomer(
  db: PrismaAdminService,
  tenantId: string,
  n: number,
  createdAt: Date,
  opts: { business?: boolean; portal?: boolean } = {},
) {
  // Cada empresa, una sola vez; si se acaban, es un particular.
  const company = (opts.business ?? chance(0.15)) ? freshName(() => pick(COMPANIES)) : null;
  const business = company !== null;
  const person = (
    freshName(() => `${pick(FIRST_NAMES)}|${pick(LAST_NAMES)} ${pick(LAST_NAMES)}`) ??
    `${pick(FIRST_NAMES)}|${pick(LAST_NAMES)} ${pick(LAST_NAMES)}`
  ).split('|');
  const first = person[0] ?? 'Cliente';
  const last = person[1] ?? 'Demo';
  const taxId = business ? `B${randomInt(10_000_000, 99_999_999)}` : dni();
  const verified = chance(0.7);
  const customer = await db.customer.create({
    data: {
      tenantId,
      customerType: business ? 'business' : 'individual',
      firstName: business ? null : first,
      lastName: business ? null : last,
      companyName: business ? company : null,
      documentType: business ? 'cif' : 'dni',
      documentNumber: taxId,
      email: demoEmail(company ?? first, business ? 'empresa' : last, n),
      phone: `6${randomInt(10_000_000, 99_999_999)}`,
      address: `${pick(STREETS)}, ${randomInt(1, 120)}`,
      city: 'Valencia',
      postalCode: `460${String(randomInt(1, 25)).padStart(2, '0')}`,
      country: 'ES',
      kycVerified: verified,
      kycVerifiedAt: verified ? createdAt : null,
      portalLastSeenAt:
        (opts.portal ?? chance(0.45)) ? new Date(Date.now() - randomInt(1, 20) * DAY) : null,
      createdAt,
    },
  });
  return { customer, name: company ?? `${first} ${last}`, taxId };
}

async function seedContracts(
  db: PrismaAdminService,
  tenantId: string,
  types: { id: string; defaultDepositAmount: unknown }[],
  insurance: { id: string; name: string; price: number } | null,
  occupancy: number,
): Promise<SeededContract[]> {
  const units = await db.unit.findMany({
    where: { tenantId, status: 'available', facility: { deletedAt: null, isActive: true } },
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      facilityId: true,
      basePriceMonthly: true,
      unitTypeId: true,
      unitType: { select: { name: true } },
      facility: { select: { name: true } },
    },
  });
  const depositOf = new Map(types.map((t) => [t.id, num(t.defaultDepositAmount)]));
  const year = new Date().getFullYear();
  const today = dateOnly(new Date());
  let contractNo = 1;
  let customerNo = 1;
  const out: SeededContract[] = [];
  const free: typeof units = [];

  const methods: PayMethod[] = [
    'card',
    'card',
    'sepa_debit',
    'sepa_debit',
    'bank_transfer',
    'cash',
  ];
  const createContract = async (
    unit: (typeof units)[number],
    status: SeededContract['status'],
    start: Date,
    end: Date | null,
    fixed?: { profile: Profile; method: PayMethod; insurance: boolean; portal: boolean },
  ) => {
    const { customer, name, taxId } = await newCustomer(db, tenantId, customerNo++, start, {
      ...(fixed ? { business: false } : {}),
    });
    const price = num(unit.basePriceMonthly);
    const deposit = depositOf.get(unit.unitTypeId) ?? 0;
    const withInsurance =
      insurance && status !== 'ended' && (fixed ? fixed.insurance : chance(0.3));
    const number = `CT-${year}-${String(contractNo++).padStart(5, '0')}`;
    const contract = await db.contract.create({
      data: {
        tenantId,
        customerId: customer.id,
        unitId: unit.id,
        contractNumber: number,
        // Se da de alta en marcha (el disparador abre su estancia desde el alta).
        status: 'active',
        startDate: start,
        signedAt: new Date(start.getTime() + 10 * 3_600_000),
        priceMonthly: price,
        depositAmount: deposit,
        depositStatus: deposit > 0 ? 'held' : 'none',
        termMonths: 12,
        ...(withInsurance
          ? { insurancePlanId: insurance.id, insurancePrice: insurance.price }
          : {}),
        createdAt: start,
      },
    });
    if (status === 'ending' && end) {
      await db.contract.update({
        where: { id: contract.id },
        data: {
          status: 'ending',
          endDate: end,
          endingRequestedAt: addDays(today, -randomInt(3, 12)),
        },
      });
    }
    if (status === 'ended' && end) {
      await db.contract.update({
        where: { id: contract.id },
        data: {
          status: 'ended',
          endDate: end,
          endedAt: new Date(end.getTime() + 12 * 3_600_000),
          depositStatus: deposit > 0 ? 'returned' : 'none',
          depositReturnedAmount: deposit,
          depositSettledAt: new Date(end.getTime() + 3 * DAY),
        },
      });
    } else {
      await db.unit.update({ where: { id: unit.id }, data: { status: 'occupied' } });
    }
    await db.contractEvent.create({
      data: {
        tenantId,
        contractId: contract.id,
        eventType: 'signed',
        payload: { channel: chance(0.5) ? 'remote' : 'in_person' },
        occurredAt: new Date(start.getTime() + 10 * 3_600_000),
      },
    });
    const profileRoll = Math.random();
    out.push({
      id: contract.id,
      number,
      customerId: customer.id,
      customerName: name,
      customerTaxId: taxId,
      unitId: unit.id,
      unitCode: unit.code,
      facilityId: unit.facilityId,
      price,
      deposit,
      insurance: withInsurance ? { name: insurance.name, price: insurance.price } : null,
      start,
      end,
      status,
      profile:
        fixed?.profile ??
        (status === 'ended'
          ? 'good'
          : profileRoll < 0.08
            ? 'debtor'
            : profileRoll < 0.2
              ? 'late'
              : 'good'),
      method: fixed?.method ?? pick(methods),
      portal: fixed?.portal ?? false,
    });
  };

  // Días del mes que ya han pasado: altas y bajas de este mes en el Resumen.
  const thisMonthDay = () =>
    addDays(
      monthStart(today.getUTCFullYear(), today.getUTCMonth()),
      randomInt(0, today.getUTCDate()),
    );
  // La inquilina del área de clientes, siempre la misma: un mediano del
  // primer local, con seguro, al día y que paga por transferencia.
  const portalUnit = units.find((u) => u.unitType.name.startsWith('Mediano')) ?? units[0] ?? null;
  if (portalUnit) {
    await createContract(portalUnit, 'active', dateOnly(addDays(today, -300)), null, {
      profile: 'good',
      method: 'bank_transfer',
      insurance: true,
      portal: true,
    });
  }
  // Un tamaño agotado en un local: la web enseña «Agotado · Avísame» y la
  // lista de espera tiene sentido.
  const soldOut = (u: (typeof units)[number]) =>
    u.facility.name === SOLD_OUT.facility && u.unitType.name.startsWith(SOLD_OUT.type);
  let newThisMonth = 0;
  for (const unit of units) {
    if (unit.id === portalUnit?.id) continue;
    if (!soldOut(unit) && !chance(occupancy)) {
      free.push(unit);
      continue;
    }
    const recent = newThisMonth < 4 && chance(0.12);
    if (recent) newThisMonth += 1;
    const start = recent ? thisMonthDay() : dateOnly(addDays(today, -randomInt(35, 700)));
    if (chance(0.08)) {
      await createContract(unit, 'ending', start, addDays(today, randomInt(10, 30)));
    } else {
      await createContract(unit, 'active', start, null);
    }
  }
  // Algunos que ya se fueron (el trastero sigue libre) y dos sin firmar.
  for (const [i, unit] of free.splice(0, 6).entries()) {
    const start = dateOnly(addDays(today, -randomInt(300, 700)));
    const end = i < 2 ? thisMonthDay() : dateOnly(addDays(today, -randomInt(35, 200)));
    await createContract(unit, 'ended', start, end);
  }
  for (const unit of free.splice(0, 2)) {
    const { customer } = await newCustomer(db, tenantId, customerNo++, addDays(today, -2), {
      portal: false,
    });
    await db.contract.create({
      data: {
        tenantId,
        customerId: customer.id,
        unitId: unit.id,
        contractNumber: `CT-${year}-${String(contractNo++).padStart(5, '0')}`,
        status: 'draft',
        startDate: addDays(today, randomInt(2, 8)),
        priceMonthly: num(unit.basePriceMonthly),
        depositAmount: depositOf.get(unit.unitTypeId) ?? 0,
        // Enlace de firma enviado (sale en «Firmas pendientes»).
        signingTokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        signingTokenExpiresAt: addDays(today, 5),
        termMonths: 12,
      },
    });
  }
  // Los libres llevan un tiempo sin alquilar («Días libre» en el Resumen).
  for (const unit of free) {
    await db.unit.update({
      where: { id: unit.id },
      data: { createdAt: addDays(today, -randomInt(4, 120)) },
    });
  }
  return out;
}

// ------------------------------------------------------ facturas y cobros

/**
 * Facturas de los últimos seis meses de cada contrato, numeradas por orden de
 * emisión, con su cobro. Devuelve las vencidas sin cobrar.
 */
async function seedInvoices(
  db: PrismaAdminService,
  tenantId: string,
  contracts: SeededContract[],
): Promise<OverdueInvoice[]> {
  const series = await db.invoiceSeries.findFirst({
    where: { tenantId, isDefault: true, isActive: true, ownerId: null },
  });
  if (!series) return [];
  const today = dateOnly(new Date());
  const from = monthStart(today.getUTCFullYear(), today.getUTCMonth() - 5);
  const drafts: DraftInvoice[] = [];
  for (const c of contracts) {
    const first = c.start > from ? c.start : from;
    let y = first.getUTCFullYear();
    let m = first.getUTCMonth();
    const last = c.end && c.end < today ? c.end : today;
    while (monthStart(y, m) <= last) {
      const ps = monthStart(y, m) > c.start ? monthStart(y, m) : c.start;
      const pe = c.end && c.end < monthEnd(y, m) ? c.end : monthEnd(y, m);
      drafts.push({
        contract: c,
        issueDate: ps,
        dueDate: addDays(ps, 15),
        periodStart: ps,
        periodEnd: pe,
        label: `${MONTHS[m]} de ${y}`,
      });
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }
  drafts.sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime());

  const overdue: OverdueInvoice[] = [];
  const seqByYear = new Map<number, number>();
  let failedPaymentDone = false;
  let partialDone = false;
  const currentYear = today.getUTCFullYear();
  for (const d of drafts) {
    const c = d.contract;
    const year = d.issueDate.getUTCFullYear();
    const seq = (seqByYear.get(year) ?? 0) + 1;
    seqByYear.set(year, seq);
    const days = Math.round((d.periodEnd.getTime() - d.periodStart.getTime()) / DAY) + 1;
    const monthDays = monthEnd(
      d.periodStart.getUTCFullYear(),
      d.periodStart.getUTCMonth(),
    ).getUTCDate();
    // El primer o último mes, por los días que se usa.
    const share = days >= monthDays ? 1 : days / monthDays;
    const rent = round2(c.price * share);
    const ins = c.insurance ? round2(c.insurance.price * share) : 0;
    const lines = [
      {
        description: `Alquiler del trastero ${c.unitCode} — ${d.label}`,
        base: rent,
        relatedUnitId: c.unitId,
      },
      ...(c.insurance
        ? [
            {
              description: `Protección de contenido — ${c.insurance.name} (${d.label})`,
              base: ins,
              relatedUnitId: null,
            },
          ]
        : []),
    ];
    const subtotal = round2(lines.reduce((s, l) => s + l.base, 0));
    const tax = round2(lines.reduce((s, l) => s + round2(l.base * 0.21), 0));
    const total = round2(subtotal + tax);
    const monthsAgo =
      (today.getUTCFullYear() - d.issueDate.getUTCFullYear()) * 12 +
      today.getUTCMonth() -
      d.issueDate.getUTCMonth();
    const thisMonth = monthsAgo === 0;
    // Quién paga:
    // - los buenos, todo; por transferencia o en el local, lo de este mes
    //   aún está por cobrar (vence a fin de mes);
    // - los que se retrasan pagan tarde y lo de este mes vence a los 15 días;
    // - los morosos deben uno o dos meses además de este.
    const debtMonths = Number(c.number.slice(-1)) % 2 === 0 ? 2 : 1;
    let paid = true;
    if (thisMonth && (c.method === 'bank_transfer' || c.method === 'cash')) paid = false;
    if (c.profile === 'late' && thisMonth) paid = false;
    if (c.profile === 'debtor' && monthsAgo <= debtMonths) paid = false;
    if (thisMonth && c.profile === 'good') {
      d.dueDate = monthEnd(today.getUTCFullYear(), today.getUTCMonth());
    }
    const due = d.dueDate < today;
    const status = paid ? 'paid' : due ? 'overdue' : 'issued';
    const payDelay = c.profile === 'late' ? 15 + randomInt(3, 11) : randomInt(0, 6);
    const paidAt = paid
      ? new Date(Math.min(d.issueDate.getTime() + payDelay * DAY + 11 * 3_600_000, Date.now()))
      : null;
    const partial = !paid && due && !partialDone;
    const invoice = await db.invoice.create({
      data: {
        tenantId,
        customerId: c.customerId,
        contractId: c.id,
        facilityId: c.facilityId,
        seriesId: series.id,
        sequenceNumber: seq,
        invoiceNumber: `${series.prefix}/${year}/${String(seq).padStart(5, '0')}`,
        status,
        invoiceType: 'F1',
        issueDate: d.issueDate,
        dueDate: d.dueDate,
        periodStart: d.periodStart,
        periodEnd: d.periodEnd,
        subtotal,
        taxAmount: tax,
        total,
        amountPaid: paid ? total : partial ? round2(total / 2) : 0,
        paidAt,
        customerNameSnapshot: c.customerName,
        customerTaxIdSnapshot: c.customerTaxId,
        createdAt: d.issueDate,
        items: {
          create: lines.map((l, i) => ({
            tenantId,
            description: l.description,
            quantity: 1,
            unitPrice: l.base,
            taxRate: 21,
            taxAmount: round2(l.base * 0.21),
            total: round2(l.base * 1.21),
            relatedContractId: c.id,
            relatedUnitId: l.relatedUnitId,
            periodStart: d.periodStart,
            periodEnd: d.periodEnd,
            position: i,
          })),
        },
      },
    });
    if (paid && paidAt) {
      await db.payment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          customerId: c.customerId,
          amount: total,
          status: 'succeeded',
          methodType: c.method,
          gateway: 'manual',
          paidAt,
          createdAt: paidAt,
        },
      });
    }
    if (partial) {
      partialDone = true;
      await db.payment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          customerId: c.customerId,
          amount: round2(total / 2),
          status: 'succeeded',
          methodType: 'cash',
          gateway: 'manual',
          paidAt: addDays(d.dueDate, 2),
          notes: 'Pago a cuenta en el local',
        },
      });
    }
    if (!paid && due) {
      overdue.push({ invoiceId: invoice.id, customerId: c.customerId, dueDate: d.dueDate });
      if (!failedPaymentDone && !partial) {
        failedPaymentDone = true;
        await db.payment.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            customerId: c.customerId,
            amount: total,
            status: 'failed',
            methodType: 'card',
            gateway: 'manual',
            failureReason: 'Tarjeta rechazada: fondos insuficientes',
            createdAt: addDays(d.dueDate, 1),
          },
        });
      }
    }
  }

  // Justificantes de la fianza (cobrada al firmar).
  for (const c of contracts) {
    if (c.deposit <= 0) continue;
    const paidAt = new Date(c.start.getTime() + 11 * 3_600_000);
    const receipt = await db.invoice.create({
      data: {
        tenantId,
        customerId: c.customerId,
        contractId: c.id,
        facilityId: c.facilityId,
        seriesId: series.id,
        sequenceNumber: 0,
        invoiceNumber: `FZ-${c.number}`,
        kind: 'deposit_receipt',
        status: 'paid',
        invoiceType: 'F1',
        issueDate: c.start,
        subtotal: c.deposit,
        taxAmount: 0,
        total: c.deposit,
        amountPaid: c.deposit,
        paidAt,
        notes:
          'Justificante de fianza: garantía reembolsable al terminar el contrato. No es una factura.',
        createdAt: c.start,
        items: {
          create: [
            {
              tenantId,
              description: `Fianza del contrato ${c.number}`,
              quantity: 1,
              unitPrice: c.deposit,
              taxRate: 0,
              taxCategory: 'N1',
              total: c.deposit,
            },
          ],
        },
      },
    });
    await db.payment.create({
      data: {
        tenantId,
        invoiceId: receipt.id,
        customerId: c.customerId,
        amount: c.deposit,
        status: 'succeeded',
        methodType: c.method,
        gateway: 'manual',
        paidAt,
        createdAt: paidAt,
      },
    });
  }

  // La serie sigue desde el último número de este año.
  await db.invoiceSeries.update({
    where: { id: series.id },
    data: { nextNumber: (seqByYear.get(currentYear) ?? 0) + 1, numberingYear: currentYear },
  });
  return overdue;
}

/**
 * Escalado de impagos de cada factura vencida, como lo habría dejado el proceso
 * de cada día: recordatorio (día 1), segundo aviso (día 7), corte de acceso
 * (día 14) y aviso legal (día 30). Devuelve a quién se le cortó el acceso.
 */
async function seedDunning(
  db: PrismaAdminService,
  tenantId: string,
  overdue: OverdueInvoice[],
): Promise<Map<string, string>> {
  const steps = [
    { type: 'email_reminder', days: 1 },
    { type: 'email_reminder_final', days: 7 },
    { type: 'access_block', days: 14 },
    { type: 'legal_notice', days: 30 },
  ] as const;
  const now = Date.now();
  const cuts = new Map<string, string>();
  const rows: Prisma.DunningActionCreateManyInput[] = [];
  for (const inv of overdue) {
    for (const stepDef of steps) {
      const at = new Date(inv.dueDate.getTime() + stepDef.days * DAY + 6 * 3_600_000);
      const done = at.getTime() <= now;
      if (done && stepDef.type === 'access_block') cuts.set(inv.customerId, inv.invoiceId);
      rows.push({
        tenantId,
        invoiceId: inv.invoiceId,
        actionType: stepDef.type,
        status: done ? 'executed' : 'scheduled',
        scheduledFor: at,
        executedAt: done ? at : null,
        ...(done && stepDef.type === 'access_block' ? { result: { accessBlocked: true } } : {}),
        createdAt: new Date(inv.dueDate.getTime() + DAY),
      });
    }
  }
  if (rows.length > 0) await db.dunningAction.createMany({ data: rows });
  return cuts;
}

// ------------------------------------------- trasteros, reservas y espera

async function seedUnitStates(db: PrismaAdminService, tenantId: string): Promise<void> {
  const free = await db.unit.findMany({
    where: { tenantId, status: 'available' },
    orderBy: { code: 'desc' },
    take: 2,
    select: { id: true },
  });
  const [a, b] = free;
  const since = new Date(Date.now() - 3 * DAY);
  if (a) {
    await db.unit.update({
      where: { id: a.id },
      data: {
        status: 'maintenance',
        maintenanceUntil: dateOnly(addDays(new Date(), 6)),
        outOfServiceReason: 'Cambio de la puerta enrollable',
        outOfServiceSince: since,
      },
    });
  }
  if (b) {
    await db.unit.update({
      where: { id: b.id },
      data: {
        status: 'blocked',
        outOfServiceReason: 'Humedad en el techo: pendiente del seguro',
        outOfServiceSince: since,
      },
    });
  }
}

async function seedReservations(
  db: PrismaAdminService,
  tenantId: string,
  types: { id: string; name: string }[],
  facilities: { id: string; name: string }[],
): Promise<void> {
  const free = await db.unit.findMany({
    where: { tenantId, status: 'available' },
    orderBy: { code: 'asc' },
    take: 2,
    select: { id: true },
  });
  const now = new Date();
  for (const [i, unit] of free.entries()) {
    const { customer } = await newCustomer(db, tenantId, 900 + i, addDays(now, -1), {
      portal: false,
    });
    const confirmed = i === 0;
    await db.reservation.create({
      data: {
        tenantId,
        unitId: unit.id,
        customerId: customer.id,
        status: confirmed ? 'confirmed' : 'pending',
        validFrom: addDays(now, -1),
        validUntil: addDays(now, confirmed ? 5 : 2),
        depositPaid: confirmed,
        depositAmount: confirmed ? 30 : 0,
        notes: confirmed ? 'Entra el lunes con una furgoneta' : 'Quiere verlo antes de decidir',
      },
    });
    if (confirmed) await db.unit.update({ where: { id: unit.id }, data: { status: 'reserved' } });
  }
  const big = types.find((t) => t.name.startsWith(SOLD_OUT.type));
  const facility = facilities.find((f) => f.name === SOLD_OUT.facility) ?? facilities[0];
  if (!big || !facility) return;
  const waiting = [
    { name: 'Rocío Ferrer', days: 18 },
    { name: 'Andrés Llorens', days: 9 },
    { name: 'Inmaculada Soler', days: 2 },
  ];
  for (const w of waiting) {
    const [first, last] = w.name.split(' ');
    await db.waitlistEntry.create({
      data: {
        tenantId,
        facilityId: facility.id,
        unitTypeId: big.id,
        contactName: w.name,
        contactEmail: demoEmail(first ?? 'cliente', last ?? 'demo', w.days),
        contactPhone: `6${randomInt(10_000_000, 99_999_999)}`,
        queueDate: addDays(now, -w.days),
        createdAt: addDays(now, -w.days),
      },
    });
  }
}

// ---------------------------------------------------------------- contactos

async function seedLeads(
  db: PrismaAdminService,
  tenantId: string,
  ownerId: string | null,
  types: { id: string }[],
  facilities: { id: string }[],
  contracts: SeededContract[],
): Promise<void> {
  // El vaciado conserva los contactos: aquí se borran todos (también los que
  // dejan las reservas hechas desde la web en cada demostración).
  await db.lead.deleteMany({ where: { tenantId } });
  const now = Date.now();
  const won = contracts.filter((c) => c.status === 'active').slice(0, 2);
  const leads: {
    first: string;
    last: string;
    status: 'new' | 'contacted' | 'qualified' | 'won' | 'lost';
    source: string;
    hoursAgo: number;
    message?: string;
    utm?: [string, string, string];
    lost?: string;
    wonContract?: SeededContract;
  }[] = [
    {
      first: 'Carla',
      last: 'Benlloch',
      status: 'new',
      source: 'web',
      hoursAgo: 2,
      message: '¿Tenéis trasteros de 6 m² libres para este mes?',
      utm: ['google', 'organic', ''],
    },
    {
      first: 'Vicente',
      last: 'Mompó',
      status: 'new',
      source: 'widget',
      hoursAgo: 7,
      message: 'Necesito guardar los muebles de un piso durante la reforma.',
      utm: ['instagram', 'social', 'promo-otono'],
    },
    {
      first: 'Lorena',
      last: 'Císcar',
      status: 'new',
      source: 'whatsapp',
      hoursAgo: 30,
      message: 'Hola, ¿qué horario tenéis los sábados?',
    },
    { first: 'Joaquín', last: 'Peris', status: 'contacted', source: 'idealista', hoursAgo: 52 },
    { first: 'Amparo', last: 'Tormo', status: 'contacted', source: 'phone', hoursAgo: 80 },
    {
      first: 'Ximo',
      last: 'Sanchis',
      status: 'contacted',
      source: 'web',
      hoursAgo: 120,
      utm: ['google', 'cpc', 'trasteros-valencia'],
    },
    { first: 'Begoña', last: 'Fuster', status: 'qualified', source: 'web', hoursAgo: 150 },
    { first: 'Toni', last: 'Climent', status: 'qualified', source: 'referral', hoursAgo: 200 },
    {
      first: 'Elisa',
      last: 'Marco',
      status: 'lost',
      source: 'idealista',
      hoursAgo: 400,
      lost: 'too_expensive',
    },
    {
      first: 'Héctor',
      last: 'Roig',
      status: 'lost',
      source: 'web',
      hoursAgo: 500,
      lost: 'found_other',
    },
    ...won.map((c, i) => ({
      first: c.customerName.split(' ')[0] ?? 'Cliente',
      last: c.customerName.split(' ').slice(1).join(' ') || 'Demo',
      status: 'won' as const,
      source: i === 0 ? 'web' : 'google',
      hoursAgo: 24 * 25 + i * 40,
      wonContract: c,
    })),
  ];
  for (const [i, l] of leads.entries()) {
    const createdAt = new Date(now - l.hoursAgo * 3_600_000);
    const lead = await db.lead.create({
      data: {
        tenantId,
        status: l.status,
        source: l.source,
        firstName: l.first,
        lastName: l.last,
        email: demoEmail(l.first, l.last, 50 + i),
        phone: `6${randomInt(10_000_000, 99_999_999)}`,
        message: l.message ?? null,
        preferredFacilityId: pick(facilities).id,
        preferredUnitTypeId: pick(types).id,
        utmSource: l.utm?.[0] ?? null,
        utmMedium: l.utm?.[1] ?? null,
        utmCampaign: l.utm?.[2] || null,
        metadata: { demo: true },
        assignedToUserId: l.status === 'new' ? null : ownerId,
        contactedAt: l.status !== 'new' ? new Date(createdAt.getTime() + 3 * 3_600_000) : null,
        qualifiedAt: ['qualified', 'won'].includes(l.status)
          ? new Date(createdAt.getTime() + DAY)
          : null,
        wonAt: l.status === 'won' ? new Date(createdAt.getTime() + 3 * DAY) : null,
        lostAt: l.status === 'lost' ? new Date(createdAt.getTime() + 4 * DAY) : null,
        lostReasonCode: l.lost ?? null,
        lostReason:
          l.lost === 'too_expensive'
            ? 'Le pareció caro frente a otro local'
            : l.lost
              ? 'Encontró otro trastero más cerca'
              : null,
        convertedCustomerId: l.wonContract?.customerId ?? null,
        convertedContractId: l.wonContract?.id ?? null,
        marketingConsentAt: chance(0.5) ? createdAt : null,
        createdAt,
      },
    });
    if (l.status === 'contacted' || l.status === 'qualified') {
      await db.leadActivity.create({
        data: {
          tenantId,
          leadId: lead.id,
          userId: ownerId,
          type: 'call',
          content: 'Llamada: le interesa, pide precio con el seguro incluido.',
          occurredAt: new Date(createdAt.getTime() + 3 * 3_600_000),
        },
      });
      const offset = l.status === 'qualified' ? 0 : i % 2 === 0 ? -1 : 3;
      await db.leadFollowup.create({
        data: {
          tenantId,
          leadId: lead.id,
          userId: ownerId,
          assignedToUserId: ownerId,
          title: l.status === 'qualified' ? 'Enseñarle el trastero' : 'Volver a llamar',
          dueDate: dateOnly(addDays(new Date(), offset)),
        },
      });
    }
  }
}

// ------------------------------------------------- tareas e incidencias

async function seedOperations(
  db: PrismaAdminService,
  tenantId: string,
  ownerId: string | null,
  contracts: SeededContract[],
): Promise<void> {
  const today = dateOnly(new Date());
  const active = contracts.filter((c) => c.status !== 'ended');
  const anyFacility = active[0]?.facilityId ?? null;
  const tasks: {
    title: string;
    type: 'cleaning' | 'maintenance' | 'inspection' | 'other';
    status: 'open' | 'in_progress' | 'done';
    priority: 'low' | 'normal' | 'high' | 'urgent';
    due: number;
  }[] = [
    {
      title: 'Revisar las cámaras del pasillo B',
      type: 'inspection',
      status: 'open',
      priority: 'high',
      due: -2,
    },
    {
      title: 'Limpieza del montacargas',
      type: 'cleaning',
      status: 'open',
      priority: 'normal',
      due: 0,
    },
    {
      title: 'Cambiar fluorescentes de la planta baja',
      type: 'maintenance',
      status: 'in_progress',
      priority: 'normal',
      due: 1,
    },
    {
      title: 'Preparar el trastero para la entrada del lunes',
      type: 'other',
      status: 'open',
      priority: 'high',
      due: 3,
    },
    {
      title: 'Reponer candados en recepción',
      type: 'other',
      status: 'open',
      priority: 'low',
      due: 6,
    },
    {
      title: 'Revisión de extintores',
      type: 'inspection',
      status: 'done',
      priority: 'normal',
      due: -7,
    },
    {
      title: 'Pintar la puerta de entrada',
      type: 'maintenance',
      status: 'done',
      priority: 'low',
      due: -15,
    },
  ];
  for (const t of tasks) {
    await db.task.create({
      data: {
        tenantId,
        title: t.title,
        type: t.type,
        status: t.status,
        priority: t.priority,
        facilityId: anyFacility,
        assignedToUserId: ownerId,
        createdByUserId: ownerId,
        dueDate: addDays(today, t.due),
        startedAt: t.status !== 'open' ? addDays(today, t.due - 1) : null,
        completedAt: t.status === 'done' ? addDays(today, t.due) : null,
        createdAt: addDays(today, Math.min(t.due, 0) - 3),
      },
    });
  }
  const pickC = (i: number) => active[i % Math.max(1, active.length)];
  const incidents: {
    title: string;
    category: string;
    severity: 'low' | 'medium' | 'high';
    status: 'reported' | 'investigating' | 'resolved';
    days: number;
    customer: boolean;
  }[] = [
    {
      title: 'La cerradura del trastero no abre bien',
      category: 'lock',
      severity: 'medium',
      status: 'reported',
      days: 1,
      customer: true,
    },
    {
      title: 'Gotera en el pasillo de la planta baja',
      category: 'water',
      severity: 'high',
      status: 'investigating',
      days: 3,
      customer: false,
    },
    {
      title: 'Puerta del trastero rozada al descargar',
      category: 'damage',
      severity: 'low',
      status: 'resolved',
      days: 12,
      customer: true,
    },
    {
      title: 'El código de acceso no funciona por la noche',
      category: 'access',
      severity: 'medium',
      status: 'resolved',
      days: 20,
      customer: true,
    },
  ];
  for (const [i, inc] of incidents.entries()) {
    const c = pickC(i + 3);
    const at = addDays(new Date(), -inc.days);
    await db.incident.create({
      data: {
        tenantId,
        title: inc.title,
        category: inc.category,
        severity: inc.severity,
        status: inc.status,
        facilityId: c?.facilityId ?? anyFacility,
        unitId: inc.customer ? (c?.unitId ?? null) : null,
        customerId: inc.customer ? (c?.customerId ?? null) : null,
        contractId: inc.customer ? (c?.id ?? null) : null,
        reportedByUserId: inc.customer ? null : ownerId,
        reportedByExternal: inc.customer ? 'Área de clientes' : null,
        visibleToCustomer: inc.customer,
        assignedToUserId: ownerId,
        occurredAt: at,
        firstResponseAt: inc.status !== 'reported' ? new Date(at.getTime() + 2 * 3_600_000) : null,
        resolvedAt: inc.status === 'resolved' ? addDays(at, 2) : null,
        resolution: inc.status === 'resolved' ? 'Revisado y arreglado por mantenimiento.' : null,
        createdAt: at,
      },
    });
  }
  // Un seguimiento de inquilino y una petición de cambio de trastero.
  const c0 = pickC(1);
  if (c0) {
    await db.customerFollowup.create({
      data: {
        tenantId,
        customerId: c0.customerId,
        userId: ownerId,
        assignedToUserId: ownerId,
        title: 'Ofrecerle el trastero grande que queda libre',
        dueDate: today,
      },
    });
  }
  const c1 = pickC(4);
  if (c1) {
    await db.unitChangeRequest.create({
      data: {
        tenantId,
        customerId: c1.customerId,
        contractId: c1.id,
        note: 'Se me ha quedado pequeño: me gustaría pasar a uno de 10 m².',
        desiredDate: addDays(today, 10),
      },
    });
  }
}

// ------------------------------------------------------------------- gastos

async function seedExpenses(
  db: PrismaAdminService,
  tenantId: string,
  facilities: { id: string; name: string }[],
): Promise<void> {
  const today = dateOnly(new Date());
  const rows: Prisma.ExpenseCreateManyInput[] = [];
  for (let k = 5; k >= 0; k--) {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth() - k;
    const day = (d: number) => {
      const date = new Date(Date.UTC(y, m, d));
      return date > today ? today : date;
    };
    for (const [i, f] of facilities.entries()) {
      const rent = i === 0 ? 950 : 750;
      const power = round2(170 + Math.random() * 90);
      rows.push(
        expense(
          tenantId,
          f.id,
          'rent',
          `Alquiler del local ${f.name}`,
          rent,
          day(1),
          'Inmobiliaria Turia SL',
          21,
        ),
        expense(
          tenantId,
          f.id,
          'utilities',
          `Luz del local ${f.name}`,
          power,
          day(8),
          'Iberdrola',
          21,
        ),
        expense(
          tenantId,
          f.id,
          'maintenance',
          `Limpieza mensual ${f.name}`,
          220,
          day(15),
          'Limpiezas Albufera',
          21,
        ),
      );
    }
    rows.push(
      expense(
        tenantId,
        null,
        'marketing',
        'Google Ads',
        round2(120 + Math.random() * 80),
        day(28),
        'Google Ireland',
        21,
      ),
      expense(tenantId, null, 'other', 'Programa de gestión', 79, day(2), 'TrasterOS', 21),
    );
  }
  // Uno pendiente de pagar.
  const pending = expense(
    tenantId,
    facilities[0]?.id ?? null,
    'maintenance',
    'Reparación de la persiana del muelle',
    480,
    addDays(today, -4),
    'Persianas Levante',
    21,
  );
  rows.push({ ...pending, paymentStatus: 'pending', paidAt: null, dueDate: addDays(today, 6) });
  await db.expense.createMany({ data: rows });
}

function expense(
  tenantId: string,
  facilityId: string | null,
  category: string,
  description: string,
  base: number,
  date: Date,
  vendor: string,
  vat: number,
): Prisma.ExpenseCreateManyInput {
  const vatAmount = round2((base * vat) / 100);
  return {
    tenantId,
    facilityId,
    category,
    description,
    amount: base,
    baseAmount: base,
    vatRate: vat,
    vatAmount,
    totalAmount: round2(base + vatAmount),
    expenseDate: date,
    vendor,
    paymentStatus: 'paid',
    paidAt: date,
    paymentMethod: 'bank_transfer',
  };
}

// ------------------------------------------------------------------ accesos

async function seedAccess(
  db: PrismaAdminService,
  tenantId: string,
  facilities: { id: string; name: string }[],
  contracts: SeededContract[],
  cuts: Map<string, string>,
): Promise<void> {
  const devices = new Map<string, string>();
  for (const f of facilities) {
    const hardwareId = `demo-${f.id.slice(0, 8)}`;
    const device = await db.accessDevice.upsert({
      where: { tenantId_hardwareId: { tenantId, hardwareId } },
      create: {
        tenantId,
        facilityId: f.id,
        type: 'door',
        name: `Puerta principal ${f.name}`,
        hardwareId,
        provider: 'stub',
        isOnline: true,
        lastSeenAt: new Date(),
      },
      update: { isOnline: true, lastSeenAt: new Date(), isActive: true },
    });
    devices.set(f.id, device.id);
  }
  const live = contracts.filter((c) => c.status !== 'ended');
  const credentials: { id: string; contract: SeededContract; suspended: boolean }[] = [];
  for (const c of live) {
    // Cortado solo a quien el escalado ya le cortó el acceso.
    const cutInvoice = cuts.get(c.customerId);
    const suspended = !!cutInvoice;
    const credential = await db.accessCredential.create({
      data: {
        tenantId,
        customerId: c.customerId,
        contractId: c.id,
        method: 'pin',
        status: suspended ? 'suspended' : 'active',
        label: 'PIN principal',
        secretPreview: `••${randomInt(10, 99)}`,
        allowedFacilityIds: [c.facilityId],
        allowedUnitIds: [c.unitId],
        activatedAt: c.start,
        suspendedAt: suspended ? addDays(new Date(), -randomInt(2, 10)) : null,
        suspendReason: suspended ? `dunning:invoice-${cutInvoice}` : null,
        createdAt: c.start,
      },
    });
    credentials.push({ id: credential.id, contract: c, suspended });
  }
  // Una semana de entradas, con algún intento fallido.
  const logs: Prisma.AccessLogCreateManyInput[] = [];
  const now = Date.now();
  for (let i = 0; i < 70; i++) {
    const cred = pick(credentials);
    if (!cred) break;
    const deviceId = devices.get(cred.contract.facilityId) ?? null;
    const day = randomInt(0, 7);
    const at = new Date(now - day * DAY);
    at.setUTCHours(randomInt(6, 20), randomInt(0, 59), 0, 0);
    if (at.getTime() > now) continue;
    const roll = Math.random();
    const result = cred.suspended
      ? 'denied_dunning'
      : roll < 0.06
        ? 'denied_invalid_credential'
        : roll < 0.09
          ? 'denied_outside_hours'
          : 'allowed';
    logs.push({
      tenantId,
      deviceId,
      credentialId: result === 'denied_invalid_credential' ? null : cred.id,
      customerId: result === 'denied_invalid_credential' ? null : cred.contract.customerId,
      method: 'pin',
      result,
      attemptedValue: `••${randomInt(10, 99)}`,
      occurredAt: at,
    });
  }
  if (logs.length > 0) await db.accessLog.createMany({ data: logs });
  for (const cred of credentials.filter((c) => !c.suspended)) {
    const last = logs
      .filter((l) => l.credentialId === cred.id && l.result === 'allowed')
      .map((l) => (l.occurredAt as Date).getTime());
    if (last.length > 0) {
      await db.accessCredential.update({
        where: { id: cred.id },
        data: { lastUsedAt: new Date(Math.max(...last)) },
      });
    }
  }
}

// ------------------------------------------------------------ valoraciones

async function seedReviews(
  db: PrismaAdminService,
  tenantId: string,
  contracts: SeededContract[],
): Promise<void> {
  const pool = contracts.filter((c) => c.profile === 'good').slice(0, 10);
  const opinions: [number, number, string | null, boolean][] = [
    [10, 5, 'Muy limpio y el acceso con el móvil es comodísimo.', true],
    [9, 5, 'Atención de diez, me ayudaron a elegir el tamaño.', true],
    [10, 5, 'Precio justo y abierto hasta tarde. Lo recomiendo.', true],
    [9, 4, 'Todo bien, el área de clientes es muy práctica.', true],
    [8, 4, 'Bien en general; la rampa podría ser más ancha.', false],
    [7, 4, null, false],
    [6, 3, 'El pasillo estaba algo sucio el último día.', false],
    [3, 2, 'Me cobraron dos veces un mes (ya me lo devolvieron).', false],
  ];
  for (const [i, c] of pool.entries()) {
    const at = addDays(new Date(), -randomInt(3, 90));
    const op = opinions[i];
    await db.review.create({
      data: {
        tenantId,
        customerId: c.customerId,
        contractId: c.id,
        token: randomBytes(18).toString('base64url'),
        tokenExpiresAt: addDays(at, 14),
        status: op ? 'submitted' : 'pending',
        npsScore: op?.[0] ?? null,
        rating: op?.[1] ?? null,
        comment: op?.[2] ?? null,
        channel: 'email',
        requestedAt: addDays(at, -2),
        submittedAt: op ? at : null,
        publishConsent: op?.[3] ?? false,
        publishedOnWeb: op?.[3] ?? false,
      },
    });
  }
}

// -------------------------------------------------------- mensajes y avisos

async function seedMessages(
  db: PrismaAdminService,
  tenantId: string,
  ownerId: string | null,
  contracts: SeededContract[],
): Promise<void> {
  const live = contracts.filter((c) => c.status !== 'ended' && !c.portal);
  const [a, b, d] = [live[2], live[5], live[8]];
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
  if (a) {
    await db.customerMessage.createMany({
      data: [
        {
          tenantId,
          customerId: a.customerId,
          senderType: 'customer',
          body: 'Hola, ¿puedo entrar el domingo por la mañana?',
          createdAt: at(60 * 26),
          readAt: at(60 * 25),
        },
        {
          tenantId,
          customerId: a.customerId,
          senderType: 'staff',
          senderUserId: ownerId,
          body: 'Sí, con tu código puedes entrar todos los días de 7:00 a 22:00.',
          createdAt: at(60 * 25),
          readAt: at(60 * 24),
        },
        {
          tenantId,
          customerId: a.customerId,
          senderType: 'customer',
          body: '¡Perfecto, gracias!',
          createdAt: at(60 * 24),
          readAt: at(60 * 23),
        },
      ],
    });
  }
  if (b) {
    await db.customerMessage.create({
      data: {
        tenantId,
        customerId: b.customerId,
        senderType: 'customer',
        body: '¿Me podéis mandar la factura de octubre a nombre de la empresa?',
        createdAt: at(45),
      },
    });
    await db.customerConversation.create({
      data: { customerId: b.customerId, tenantId, status: 'pending' },
    });
  }
  if (d) {
    await db.customerMessage.create({
      data: {
        tenantId,
        customerId: d.customerId,
        senderType: 'customer',
        channel: 'whatsapp',
        body: 'Buenas, quiero ampliar a un trastero más grande el mes que viene.',
        createdAt: at(180),
      },
    });
  }
  // Historial de comunicaciones enviadas (ya enviadas: no salen de nuevo).
  const sent = live.slice(0, 6);
  const subjects = [
    'Nueva factura del alquiler de tu trastero',
    'Pago recibido',
    'Tu contrato está firmado',
    'Recordatorio: tienes una factura pendiente',
    'Tu código de acceso',
    'Nueva factura del alquiler de tu trastero',
  ];
  for (const [i, c] of sent.entries()) {
    const customer = await db.customer.findUnique({
      where: { id: c.customerId },
      select: { email: true },
    });
    if (!customer?.email) continue;
    const when = at(60 * 24 * (i + 1));
    await db.communication.create({
      data: {
        tenantId,
        channel: 'email',
        status: i === 3 ? 'delivered' : 'sent',
        customerId: c.customerId,
        contractId: c.id,
        recipient: customer.email,
        subject: subjects[i] ?? null,
        bodyText: `${subjects[i] ?? ''}.`,
        source: 'demo',
        provider: 'demo',
        sentAt: when,
        deliveredAt: i === 3 ? when : null,
        createdAt: when,
      },
    });
  }
  const notices = [
    {
      type: 'lead.created',
      title: 'Nuevo contacto desde la web: Carla Benlloch',
      link: '/leads',
      minutes: 120,
    },
    {
      type: 'customer.message',
      title: 'Mensaje nuevo de un inquilino',
      link: '/messages',
      minutes: 45,
    },
    {
      type: 'incident.created',
      title: 'Incidencia: la cerradura del trastero no abre bien',
      link: '/incidents',
      minutes: 60 * 20,
    },
    {
      type: 'invoice.overdue',
      title: 'Hay facturas vencidas sin cobrar',
      link: '/arrears',
      minutes: 60 * 30,
    },
  ];
  await db.notification.createMany({
    data: notices.map((n) => ({
      tenantId,
      type: n.type,
      title: n.title,
      link: n.link,
      createdAt: at(n.minutes),
    })),
  });
}

// ------------------------------------------------------------ competencia

async function ensureCompetitors(
  db: PrismaAdminService,
  tenantId: string,
  facilities: { id: string }[],
): Promise<void> {
  if ((await db.competitorFacility.count({ where: { tenantId } })) > 0) return;
  const now = new Date();
  const list = [
    {
      name: 'BoxStore Valencia',
      zone: 'Ruzafa',
      facilityId: facilities[0]?.id ?? null,
      distanceKm: 1.2,
      inventoryComplete: true,
      knownTotalUnits: null as number | null,
      promo: '1 mes gratis',
      units: [
        [3, 55, 'occupied'],
        [3, 55, 'available'],
        [6, 92, 'occupied'],
        [6, 92, 'occupied'],
        [10, 145, 'occupied'],
        [10, 139, 'available'],
      ] as [number, number, string][],
    },
    {
      name: 'Trasteros Turia',
      zone: 'Benicalap',
      facilityId: facilities[1]?.id ?? null,
      distanceKm: 2.4,
      inventoryComplete: false,
      knownTotalUnits: 60,
      promo: null,
      units: [
        [1, 32, 'available'],
        [4, 62, 'occupied'],
        [8, 110, 'available'],
      ] as [number, number, string][],
    },
  ];
  for (const c of list) {
    const competitor = await db.competitorFacility.create({
      data: {
        tenantId,
        name: c.name,
        zone: c.zone,
        facilityId: c.facilityId,
        priceIncludesVat: true,
        distanceKm: c.distanceKm,
        inventoryComplete: c.inventoryComplete,
        inventoryCompletedAt: c.inventoryComplete ? now : null,
        knownTotalUnits: c.knownTotalUnits,
        currentPromotion: c.promo,
        promoFreeMonths: c.promo ? 1 : null,
        contactMethod: 'web',
        lastReviewedAt: now,
      },
    });
    for (const [area, price, status] of c.units) {
      const unit = await db.competitorUnit.create({
        data: {
          tenantId,
          competitorFacilityId: competitor.id,
          areaM2: area,
          priceMonthly: price,
          status,
          lastCheckedAt: now,
        },
      });
      // La comprobación de hace 40 días tenía otro precio: hay evolución.
      await db.competitorUnitObservation.createMany({
        data: [
          {
            tenantId,
            competitorUnitId: unit.id,
            observedAt: addDays(now, -40),
            priceMonthly: round2(price * (area >= 6 ? 1.06 : 0.95)),
            status: 'available',
          },
          { tenantId, competitorUnitId: unit.id, observedAt: now, priceMonthly: price, status },
        ],
      });
    }
  }
}

// --------------------------------------------- inquilina del área de clientes

/** PIN de la inquilina de la demo (lo ve en su área de clientes). */
const PORTAL_PIN = '482913';

/**
 * Laura: la inquilina con la que el comercial entra al área de clientes. Paga
 * por transferencia (la factura de este mes está por pagar), tiene su PIN a la
 * vista y una conversación con el equipo.
 */
async function seedPortalCustomer(
  db: PrismaAdminService,
  tenantId: string,
  ownerId: string | null,
  contracts: SeededContract[],
  encryptSecret: ((plain: string) => string) | undefined,
): Promise<void> {
  const c = contracts.find((x) => x.portal);
  if (!c) return;
  const name = 'Laura Martín Sanz';
  await db.customer.update({
    where: { id: c.customerId },
    data: {
      customerType: 'individual',
      firstName: 'Laura',
      lastName: 'Martín Sanz',
      companyName: null,
      documentType: 'dni',
      email: 'laura.martin@example.com',
      phone: '612345678',
      address: 'Calle de Cuba, 24, 3.º B',
      kycVerified: true,
      tags: [DEMO_PORTAL_CUSTOMER_TAG],
    },
  });
  await db.invoice.updateMany({
    where: { tenantId, customerId: c.customerId },
    data: { customerNameSnapshot: name },
  });
  // Este mes está por pagar (paga por transferencia).
  const today = dateOnly(new Date());
  await db.invoice.updateMany({
    where: {
      tenantId,
      customerId: c.customerId,
      kind: 'invoice',
      issueDate: { gte: monthStart(today.getUTCFullYear(), today.getUTCMonth()) },
      status: 'issued',
    },
    data: { dueDate: monthEnd(today.getUTCFullYear(), today.getUTCMonth()) },
  });
  if (encryptSecret) {
    await db.accessCredential.updateMany({
      where: { tenantId, customerId: c.customerId, method: 'pin' },
      data: {
        status: 'active',
        suspendedAt: null,
        suspendReason: null,
        secretEncrypted: encryptSecret(PORTAL_PIN),
        secretPreview: `••${PORTAL_PIN.slice(-2)}`,
      },
    });
  }
  const at = (days: number, hour: number) => {
    const d = addDays(new Date(), -days);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };
  await db.customerMessage.createMany({
    data: [
      {
        tenantId,
        customerId: c.customerId,
        senderType: 'staff',
        senderUserId: ownerId,
        body: '¡Bienvenida, Laura! Cualquier cosa que necesites, escríbenos por aquí.',
        createdAt: at(20, 9),
        readAt: at(20, 12),
      },
      {
        tenantId,
        customerId: c.customerId,
        senderType: 'customer',
        body: 'Gracias. ¿Puedo dejar la bici dentro del trastero?',
        createdAt: at(19, 18),
        readAt: at(19, 19),
      },
      {
        tenantId,
        customerId: c.customerId,
        senderType: 'staff',
        senderUserId: ownerId,
        body: 'Sí, sin problema. Solo te pedimos que no guardes combustible ni baterías.',
        createdAt: at(19, 19),
        readAt: at(18, 8),
      },
    ],
  });
}
