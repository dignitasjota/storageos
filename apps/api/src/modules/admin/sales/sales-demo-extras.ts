import { randomBytes, randomInt } from 'node:crypto';

import { DEMO_PORTAL_CUSTOMER_TAG } from '@storageos/shared';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { Prisma } from '@storageos/database';

/**
 * Lo que completa la cuenta de demostración además de los datos del día a día
 * (`sales-demo-data.ts`): la configuración se deja como al crearla (un ajuste
 * que toque un comercial no pasa a la siguiente demo), el catálogo que el
 * vaciado conserva se rehace, y se siembra lo que antes salía vacío (preguntas
 * frecuentes, canales, visitas de la web, automatizaciones, mantenimiento,
 * blog, un expediente de impago, el cierre de caja, pases nocturnos y
 * referidos).
 *
 * Lo que no se toca: las fotos de los locales, el logo, el favicon y las fotos
 * de la portada (las sube la dirección una vez y se quedan).
 */

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)]!;
const dateOnly = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/** Funciones que la demo tiene activadas además de su plan. */
export const DEMO_EXTRA_FEATURES = ['web_premium', 'local_seo'] as const;

/** Contrato sembrado (lo que necesitan estas partes). */
export interface DemoContract {
  id: string;
  customerId: string;
  unitId: string;
  facilityId: string;
  status: 'active' | 'ending' | 'ended';
  profile: 'good' | 'late' | 'debtor';
  start: Date;
  portal: boolean;
}

// ----------------------------------------------------------- configuración

/** Ajustes del negocio como al crear la demo (el reinicio los devuelve aquí). */
export async function restoreDemoConfig(db: PrismaAdminService, tenantId: string): Promise<void> {
  await db.tenant.update({
    where: { id: tenantId },
    data: {
      name: 'Trasteros Demo',
      portalBrandColor: '#1E3A8A',
      webHeaderBranded: false,
      webTemplate: 'cabe',
      webHeadline: 'Trasteros en Valencia, abiertos todos los días',
      webAbout:
        'Somos un negocio familiar con dos locales en Valencia. Trasteros limpios, con acceso por código desde el móvil y sin permanencia: entras cuando quieras y te vas cuando quieras.',
      webSections: { testimonials: true, faq: true, contact: true },
      webContent: {},
      webSeo: {},
      webLegal: {},
      googleReviewUrl: null,
      lateFeeEnabled: false,
      autoChargeOnIssue: false,
      autoChargeRetryEnabled: false,
      reviewsAutoRequest: false,
      referralEnabled: true,
      referralRewardType: 'fixed',
      referralRewardValue: 15,
      nightPassEnabled: true,
      nightPassPrice: 5,
      collectionsEnabled: true,
      winbackEnabled: false,
      webChatEnabled: true,
    },
  });
  for (const feature of DEMO_EXTRA_FEATURES) {
    await db.tenantFeatureOverride.upsert({
      where: { tenantId_feature: { tenantId, feature } },
      create: { tenantId, feature, enabled: true, source: 'manual' },
      update: { enabled: true, expiresAt: null },
    });
  }
  const extras: Record<string, Prisma.FacilityUpdateManyMutationInput> = {
    Centro: {
      directions:
        'A dos minutos del metro de Colón. Aparcamiento para carga y descarga en la puerta, junto al portón azul.',
      mapsUrl: 'https://maps.google.com/?q=Calle+de+Colón+12+Valencia',
      features: ['24h', 'cctv', 'ground_floor', 'online_booking'],
      accessCurfewEnabled: false,
    },
    Norte: {
      directions:
        'En la avenida de Burjassot, frente a la gasolinera. Entrada para furgonetas por la calle lateral.',
      mapsUrl: 'https://maps.google.com/?q=Avenida+de+Burjassot+88+Valencia',
      features: ['vehicle_access', 'cctv', 'online_booking'],
      // De noche, solo con pase nocturno.
      accessCurfewEnabled: true,
      accessCurfewStart: '23:00',
      accessCurfewEnd: '06:00',
    },
  };
  for (const [name, data] of Object.entries(extras)) {
    await db.facility.updateMany({
      where: { tenantId, name },
      data: {
        ...data,
        contactEmail: 'hola@example.com',
        openingExceptions: [],
        videoUrl: null,
        preOpening: false,
        openingDate: null,
        pricingPositioningPct: 0,
      },
    });
  }
}

/**
 * Catálogo que el vaciado conserva y la demo vuelve a crear: lo que un
 * comercial haya cambiado (un cupón, una promoción, una pregunta) no pasa a la
 * siguiente demostración.
 */
export async function clearDemoCatalog(db: PrismaAdminService, tenantId: string): Promise<void> {
  const where = { tenantId };
  const steps: [string, () => Promise<unknown>][] = [
    ['canales', () => db.marketingChannel.deleteMany({ where })],
    ['cupones', () => db.coupon.deleteMany({ where })],
    ['promociones', () => db.promotion.deleteMany({ where })],
    ['seguros', () => db.insurancePlan.deleteMany({ where })],
    ['productos', () => db.product.deleteMany({ where })],
    ['competencia', () => db.competitorFacility.deleteMany({ where })],
    ['preguntas', () => db.faqEntry.deleteMany({ where })],
    ['automatizaciones', () => db.automationRule.deleteMany({ where })],
    ['mantenimiento', () => db.maintenancePlan.deleteMany({ where })],
    ['blog', () => db.blogPost.deleteMany({ where })],
  ];
  for (const [, run] of steps) {
    // Cada uno por su lado: si uno no se puede borrar, se crea encima.
    await run().catch(() => undefined);
  }
}

// ------------------------------------------------------------- web y blog

export async function seedFaq(db: PrismaAdminService, tenantId: string): Promise<void> {
  const faqs = [
    ['¿Hay permanencia mínima?', 'No. Pagas mes a mes y te das de baja con 15 días de preaviso.'],
    [
      '¿Cuándo puedo entrar a mi trastero?',
      'En el local Centro, a cualquier hora con tu código o desde el móvil. En Norte, de 6:00 a 23:00; por la noche, con un pase nocturno.',
    ],
    [
      '¿Qué no puedo guardar?',
      'Nada inflamable, perecedero, ilegal ni seres vivos. El contrato lleva la lista completa.',
    ],
    [
      '¿Tengo que pagar fianza?',
      'Sí, una mensualidad, y te la devolvemos al terminar si el trastero queda como lo recibiste.',
    ],
    [
      '¿Está asegurado lo que guardo?',
      'Puedes añadir la protección de contenido por 4,50 € al mes, con cobertura de hasta 3.000 €.',
    ],
  ] as const;
  await db.faqEntry.createMany({
    data: faqs.map(([question, answer], position) => ({ tenantId, question, answer, position })),
  });
}

export async function seedBlog(db: PrismaAdminService, tenantId: string): Promise<void> {
  const now = Date.now();
  const posts = [
    {
      slug: 'como-elegir-el-tamano-de-tu-trastero',
      title: 'Cómo elegir el tamaño de tu trastero',
      excerpt: 'Una guía rápida para no pagar por metros que no usas.',
      content:
        '## Empieza por lo que vas a guardar\n\nUn trastero de **3 m²** basta para las cajas y la bici de un estudio. Para los muebles de un piso de dos habitaciones, mejor **6 m²**.\n\n[[calculadora]]\n\n## Deja un pasillo\n\nSi vas a entrar a menudo, deja un pasillo en el centro: ganarás tiempo cada vez que busques algo.\n\n[[boton: Ver tamaños y precios | web:precios]]',
      days: 20,
    },
    {
      slug: 'mudanza-sin-estres',
      title: 'Mudanza sin estrés: guarda primero, decide después',
      excerpt: 'Cinco ideas para que la mudanza no se te coma el mes.',
      content:
        '## Guarda lo que no necesitas ya\n\nLleva al trastero lo de temporada antes de empezar con las cajas de la casa.\n\n## Etiqueta por habitación\n\nUna etiqueta por caja con la habitación de destino ahorra horas al llegar.\n\n[[tamanos]]',
      days: 6,
    },
  ];
  for (const p of posts) {
    const at = new Date(now - p.days * DAY);
    await db.blogPost.create({
      data: {
        tenantId,
        slug: p.slug,
        title: p.title,
        excerpt: p.excerpt,
        contentMarkdown: p.content,
        isPublished: true,
        publishedAt: at,
        createdAt: at,
      },
    });
  }
}

/** Un mes de visitas a la web, con su origen, para Marketing → Visitas de la web. */
export async function seedWebVisits(db: PrismaAdminService, tenantId: string): Promise<void> {
  const sources = [
    { source: 'google', medium: 'organic', campaign: '', weight: 5 },
    { source: '', medium: '', campaign: '', weight: 3 },
    { source: 'instagram', medium: 'social', campaign: 'promo-otono', weight: 2 },
    { source: 'google', medium: 'cpc', campaign: 'trasteros-valencia', weight: 2 },
    { source: 'idealista', medium: 'referral', campaign: '', weight: 1 },
  ];
  const bag = sources.flatMap((s) => Array.from({ length: s.weight }, () => s));
  const paths = ['/', '/', '/centro', '/norte', '/precios', '/blog/mudanza-sin-estres'];
  const today = dateOnly(new Date());
  const visits: Prisma.WebVisitCreateManyInput[] = [];
  const pages = new Map<
    string,
    { day: Date; path: string; views: number; visitors: number; clicks: number }
  >();
  for (let d = 29; d >= 0; d--) {
    const day = addDays(today, -d);
    const count = randomInt(14, 38);
    for (let i = 0; i < count; i++) {
      const s = pick(bag);
      const entryPath = pick(paths);
      const pageViews = randomInt(1, 5);
      const calls = Math.random() < 0.05 ? 1 : 0;
      const whatsapp = Math.random() < 0.06 ? 1 : 0;
      const bookingStarts = Math.random() < 0.08 ? 1 : 0;
      visits.push({
        tenantId,
        day,
        visitorId: randomBytes(8).toString('hex'),
        source: s.source,
        medium: s.medium,
        campaign: s.campaign,
        device: Math.random() < 0.68 ? 'mobile' : 'desktop',
        entryPath,
        pageViews,
        calls,
        whatsapp,
        emails: 0,
        directions: Math.random() < 0.04 ? 1 : 0,
        bookingStarts,
      });
      const key = `${day.toISOString()}|${entryPath}`;
      const page = pages.get(key) ?? { day, path: entryPath, views: 0, visitors: 0, clicks: 0 };
      page.views += pageViews;
      page.visitors += 1;
      page.clicks += calls + whatsapp;
      pages.set(key, page);
    }
  }
  await db.webVisit.createMany({ data: visits, skipDuplicates: true });
  await db.webPageDaily.createMany({
    data: [...pages.values()].map((p) => ({ tenantId, ...p })),
    skipDuplicates: true,
  });
}

// ------------------------------------------------------- marketing y cupón

export async function seedCoupon(db: PrismaAdminService, tenantId: string): Promise<void> {
  await db.coupon.create({
    data: {
      tenantId,
      code: 'TRESMESES',
      name: 'Contrata 3 meses y el tercero es gratis',
      discountType: 'free_months',
      discountValue: 1,
      minMonths: 3,
      newCustomersOnly: true,
      announceOnWeb: false,
    },
  });
}

export async function seedChannels(
  db: PrismaAdminService,
  tenantId: string,
  facilities: { id: string; name: string }[],
): Promise<void> {
  const centro = facilities.find((f) => f.name === 'Centro')?.id ?? null;
  const today = dateOnly(new Date());
  const channels = [
    {
      name: 'Idealista — anuncio Centro',
      type: 'real_estate_portal',
      utm: 'idealista',
      cost: 49,
      renews: 12,
      clicks: 64,
      facilityId: centro,
    },
    {
      name: 'Instagram — campaña de otoño',
      type: 'other',
      utm: 'instagram',
      cost: 120,
      renews: null,
      clicks: 212,
      facilityId: null,
    },
    {
      name: 'Folletos en el barrio',
      type: 'physical',
      utm: 'folleto',
      cost: 60,
      renews: null,
      clicks: 23,
      facilityId: centro,
    },
  ];
  for (const c of channels) {
    await db.marketingChannel.create({
      data: {
        tenantId,
        name: c.name,
        type: c.type,
        facilityId: c.facilityId,
        utmSourceMatch: c.utm,
        monthlyCost: c.cost,
        renewsOn: c.renews ? addDays(today, c.renews) : null,
        shortCode: randomBytes(5).toString('base64url'),
        clickCount: c.clicks,
      },
    });
  }
}

export async function seedAutomations(db: PrismaAdminService, tenantId: string): Promise<void> {
  const templates = await db.messageTemplate.findMany({
    where: {
      tenantId,
      code: { in: ['contract_ending_soon_email', 'review_request_email', 'lead_thanks_email'] },
    },
    select: { id: true, code: true },
  });
  const id = (code: string) => templates.find((t) => t.code === code)?.id ?? null;
  const rules = [
    {
      name: 'Aviso de fin de contrato',
      trigger: 'contract_ending_soon',
      code: 'contract_ending_soon_email',
      delay: 0,
    },
    {
      name: 'Gracias por tu interés',
      trigger: 'lead_created',
      code: 'lead_thanks_email',
      delay: 5,
    },
  ] as const;
  for (const r of rules) {
    const templateId = id(r.code);
    if (!templateId) continue;
    await db.automationRule.create({
      data: {
        tenantId,
        name: r.name,
        trigger: r.trigger,
        actionType: 'send_email',
        templateId,
        delayMinutes: r.delay,
      },
    });
  }
}

// ------------------------------------------------------------ operación

export async function seedMaintenancePlans(
  db: PrismaAdminService,
  tenantId: string,
  facilities: { id: string; name: string }[],
  ownerId: string | null,
): Promise<void> {
  const today = dateOnly(new Date());
  const centro = facilities.find((f) => f.name === 'Centro')?.id ?? null;
  const norte = facilities.find((f) => f.name === 'Norte')?.id ?? null;
  await db.maintenancePlan.create({
    data: {
      tenantId,
      title: 'Ronda de cierre',
      description: 'Revisar puertas, luces y cámaras antes de cerrar.',
      type: 'inspection',
      facilityId: centro,
      assignedToUserId: ownerId,
      freq: 'weekly',
      weekdays: [1, 3, 5],
      checklistTemplate: [
        { label: 'Puerta principal cerrada' },
        { label: 'Luces de los pasillos apagadas' },
        { label: 'Cámaras grabando' },
      ],
      startDate: addDays(today, -60),
      nextRunDate: addDays(today, 1),
    },
  });
  await db.maintenancePlan.create({
    data: {
      tenantId,
      title: 'Revisión de extintores',
      type: 'maintenance',
      facilityId: norte,
      assignedToUserId: ownerId,
      freq: 'monthly',
      interval: 3,
      dayOfMonth: 15,
      startDate: addDays(today, -90),
      nextRunDate: addDays(today, 26),
      estimatedCost: 80,
    },
  });
}

/** Un expediente de impago con el candado puesto (Cobros → Impagos). */
export async function seedCollectionsCase(
  db: PrismaAdminService,
  tenantId: string,
  contracts: DemoContract[],
  cuts: Map<string, string>,
  ownerId: string | null,
): Promise<void> {
  const target = contracts.find((c) => cuts.has(c.customerId) && c.status !== 'ended');
  if (!target) return;
  const overdue = await db.invoice.findMany({
    where: { tenantId, customerId: target.customerId, status: 'overdue' },
    select: { total: true, amountPaid: true },
  });
  const debt = overdue.reduce(
    (s, i) => s + Math.round((Number(i.total) - Number(i.amountPaid)) * 100),
    0,
  );
  const opened = addDays(new Date(), -9);
  const overlocked = addDays(new Date(), -6);
  const created = await db.delinquencyCase.create({
    data: {
      tenantId,
      contractId: target.id,
      customerId: target.customerId,
      unitId: target.unitId,
      facilityId: target.facilityId,
      status: 'overlocked',
      debtSnapshot: debt,
      openedAt: opened,
      overlockedAt: overlocked,
      openedByUserId: ownerId,
      notes: 'Le hemos llamado dos veces sin respuesta.',
      createdAt: opened,
    },
  });
  await db.delinquencyCaseEvent.createMany({
    data: [
      {
        tenantId,
        caseId: created.id,
        eventType: 'opened',
        occurredAt: opened,
        createdByUserId: ownerId,
      },
      {
        tenantId,
        caseId: created.id,
        eventType: 'overlocked',
        payload: { note: 'Candado de la empresa puesto en la puerta' },
        occurredAt: overlocked,
        createdByUserId: ownerId,
      },
    ],
  });
}

/** El cierre de caja de ayer. */
export async function seedCashClosure(
  db: PrismaAdminService,
  tenantId: string,
  ownerId: string | null,
): Promise<void> {
  const yesterday = addDays(dateOnly(new Date()), -1);
  const cash = await db.payment.aggregate({
    where: {
      tenantId,
      status: 'succeeded',
      methodType: 'cash',
      paidAt: { gte: yesterday, lt: addDays(yesterday, 1) },
    },
    _sum: { amount: true },
  });
  const expected = round2(Number(cash._sum.amount ?? 0));
  await db.cashClosure.create({
    data: {
      tenantId,
      closureDate: yesterday,
      expectedCash: expected,
      countedCash: expected,
      difference: 0,
      notes: 'Todo cuadra.',
      closedByUserId: ownerId,
      closedAt: new Date(yesterday.getTime() + 20 * 3_600_000),
    },
  });
}

/**
 * Dos pases nocturnos comprados (uno usado y otro para esta noche), con su
 * factura, en el local que tiene el horario nocturno cerrado.
 */
export async function seedNightPasses(
  db: PrismaAdminService,
  tenantId: string,
  contracts: DemoContract[],
  facilities: { id: string; name: string }[],
): Promise<void> {
  const norte = facilities.find((f) => f.name === 'Norte');
  if (!norte) return;
  const buyers = contracts
    .filter((c) => c.facilityId === norte.id && c.status === 'active' && c.profile === 'good')
    .slice(0, 2);
  const series = await db.invoiceSeries.findFirst({
    where: { tenantId, isDefault: true, isActive: true, ownerId: null },
  });
  if (!series || buyers.length === 0) return;
  const today = dateOnly(new Date());
  const year = today.getUTCFullYear();
  let next = series.nextNumber;
  for (const [i, c] of buyers.entries()) {
    const used = i === 0;
    const bought = used ? addDays(today, -3) : today;
    const customer = await db.customer.findUnique({
      where: { id: c.customerId },
      select: { firstName: true, lastName: true, companyName: true, documentNumber: true },
    });
    await db.accessCredential.create({
      data: {
        tenantId,
        customerId: c.customerId,
        method: 'pin',
        status: used ? 'expired' : 'active',
        label: 'Pase nocturno',
        secretPreview: `••${randomInt(10, 99)}`,
        allowedFacilityIds: [norte.id],
        bypassCurfew: true,
        maxUses: 1,
        usesCount: used ? 1 : 0,
        expiresAt: new Date(addDays(bought, 1).getTime() + 7 * 3_600_000),
        activatedAt: bought,
        metadata: { source: 'night_pass' },
        createdAt: new Date(bought.getTime() + 19 * 3_600_000),
      },
    });
    const base = 5;
    const tax = round2(base * 0.21);
    const paidAt = new Date(bought.getTime() + 19 * 3_600_000);
    const invoice = await db.invoice.create({
      data: {
        tenantId,
        customerId: c.customerId,
        facilityId: norte.id,
        seriesId: series.id,
        sequenceNumber: next,
        invoiceNumber: `${series.prefix}/${year}/${String(next).padStart(5, '0')}`,
        status: 'paid',
        invoiceType: 'F1',
        issueDate: bought,
        subtotal: base,
        taxAmount: tax,
        total: round2(base + tax),
        amountPaid: round2(base + tax),
        paidAt,
        customerNameSnapshot:
          customer?.companyName ??
          `${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`.trim(),
        customerTaxIdSnapshot: customer?.documentNumber ?? null,
        items: {
          create: [
            {
              tenantId,
              description: 'Pase nocturno',
              quantity: 1,
              unitPrice: base,
              taxRate: 21,
              taxAmount: tax,
              total: round2(base + tax),
              position: 0,
            },
          ],
        },
      },
    });
    await db.payment.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        customerId: c.customerId,
        amount: round2(base + tax),
        status: 'succeeded',
        methodType: 'card',
        gateway: 'manual',
        paidAt,
        createdAt: paidAt,
      },
    });
    next += 1;
  }
  await db.invoiceSeries.update({ where: { id: series.id }, data: { nextNumber: next } });
}

/**
 * Programa de referidos: la inquilina del área de clientes ha recomendado a
 * dos personas (una ya es cliente y otra está por firmar).
 */
export async function seedReferrals(
  db: PrismaAdminService,
  tenantId: string,
  contracts: DemoContract[],
): Promise<void> {
  const laura = await db.customer.findFirst({
    where: { tenantId, tags: { has: DEMO_PORTAL_CUSTOMER_TAG } },
    select: { id: true },
  });
  if (!laura) return;
  await db.customer.update({ where: { id: laura.id }, data: { referralCode: 'LAURA15' } });
  const converted = contracts
    .filter((c) => c.status === 'active' && !c.portal)
    .sort((a, b) => b.start.getTime() - a.start.getTime())[0];
  const pending = await db.customer.findFirst({
    where: { tenantId, contracts: { some: { status: 'draft' } } },
    select: { id: true },
  });
  if (converted) {
    await db.referral.create({
      data: {
        tenantId,
        referrerCustomerId: laura.id,
        referredCustomerId: converted.customerId,
        status: 'converted',
        rewardType: 'fixed',
        rewardValue: 15,
        convertedAt: converted.start,
        createdAt: addDays(converted.start, -3),
      },
    });
  }
  if (pending) {
    await db.referral.create({
      data: { tenantId, referrerCustomerId: laura.id, referredCustomerId: pending.id },
    });
  }
}
