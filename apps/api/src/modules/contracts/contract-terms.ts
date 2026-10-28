import { createHash } from 'node:crypto';

import {
  DEFAULT_STORAGE_CLAUSES,
  contractClausesTemplate,
  renderContractClauses,
  rentTax,
} from '@storageos/shared';

import type { Prisma } from '@storageos/database';

/** Datos de una parte del contrato (arrendador o inquilino). */
interface PartyInput {
  name: string;
  taxId?: string | null;
  address?: string | null;
}

export interface ContractTermsInput {
  /** Reserva antes de la apertura del local (aún sin empezar). */
  preOpening?: {
    /** Fecha de apertura prevista (`YYYY-MM-DD`), o null si aún no está fijada. */
    openingDate: string | null;
    /** Fecha límite (`YYYY-MM-DD`): sin abrir antes, se puede cancelar con devolución total. */
    deadline: string;
    maxMonths: number;
    unitTypeName: string;
  } | null;
  contractNumber: string;
  customerName: string;
  unitCode: string;
  facilityName: string;
  priceMonthly: number;
  depositAmount: number;
  billingCycle: string;
  startDate: string;
  /** Cláusulas YA renderizadas (variables sustituidas). */
  customClauses?: string | null;
  /** true = son las condiciones generales por defecto (no las del tenant). */
  defaultClauses?: boolean;
  /** `housing` = contrato de vivienda. */
  propertyKind?: string | null;
  /** Quién alquila (el negocio o el propietario del local). */
  landlord?: PartyInput | null;
  /** Negocio que gestiona el local en nombre del propietario. */
  managedBy?: string | null;
  /** Documento y domicilio del inquilino. */
  customer?: {
    documentLabel?: string | null;
    documentNumber?: string | null;
    address?: string | null;
  } | null;
  unitDescription?: string | null;
  facilityAddress?: string | null;
  endDate?: string | null;
  autoRenew?: boolean;
  cancellationNoticeDays?: number;
  vatRate?: number;
  discountAmount?: number;
  discountReason?: string | null;
  freeMonths?: number;
  coupon?: { code: string; discountAmount: number; freeMonths: number; months: number } | null;
  firstPaymentMonths?: number;
  billingIntervalMonths?: number;
  prepayDiscountPct?: number;
  insurance?: { name: string; price: number; taxRate: number } | null;
  depositCash?: boolean;
}

const CYCLE_LABEL: Record<string, string> = {
  monthly: 'mensual',
  weekly: 'semanal',
  daily: 'diaria',
};

/** `1250.5` → `1250,50 €` (determinista: no depende del ICU del servidor). */
function eur(n: number): string {
  return `${n.toFixed(2).replace('.', ',')} €`;
}

/** `2026-02-01` → `01/02/2026`. */
function day(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function party(p: PartyInput): string {
  return [p.name, p.taxId ? `NIF ${p.taxId}` : null, p.address || null].filter(Boolean).join(' · ');
}

/**
 * Texto del contrato que se muestra al firmar, cuya huella SHA-256 se guarda
 * como prueba de qué se firmó y que el PDF reproduce. Determinista: el mismo
 * contrato produce siempre el mismo texto (y por tanto la misma huella).
 */
export function buildContractTermsText(t: ContractTermsInput): string {
  const housing = t.propertyKind === 'housing';
  const cycle = CYCLE_LABEL[t.billingCycle] ?? t.billingCycle;
  const unitWord = housing ? 'Vivienda' : 'Trastero';

  const header = [
    housing
      ? `Contrato de arrendamiento de vivienda ${t.contractNumber}`
      : `Contrato de alquiler de trastero ${t.contractNumber}`,
  ];
  if (t.landlord) {
    header.push(`Arrendador: ${party(t.landlord)}`);
    if (t.managedBy) header.push(`Gestionado por: ${t.managedBy}`);
  }
  const customerParts = [
    t.customerName,
    t.customer?.documentNumber
      ? `${t.customer.documentLabel || 'Documento'} ${t.customer.documentNumber}`
      : null,
    t.customer?.address || null,
  ].filter(Boolean);
  header.push(`Inquilino: ${customerParts.join(' · ')}`);
  header.push(
    `${unitWord}: ${t.unitCode}${t.unitDescription ? ` (${t.unitDescription})` : ''} — ${t.facilityName}${t.facilityAddress ? `, ${t.facilityAddress}` : ''}`,
  );

  // Duración
  header.push(
    t.preOpening
      ? `Inicio: el día de apertura del local${t.preOpening.openingDate ? ` (prevista aproximadamente para el ${day(t.preOpening.openingDate)})` : ' (fecha aún por confirmar)'}`
      : `Inicio: ${day(t.startDate)}`,
  );
  if (t.endDate) {
    header.push(`Fin: ${day(t.endDate)}`);
  } else if (t.autoRenew !== undefined) {
    header.push(
      t.autoRenew
        ? 'Duración: indefinida, se renueva en cada periodo de facturación'
        : 'Duración: sin renovación automática',
    );
  }
  if (t.cancellationNoticeDays !== undefined) {
    header.push(`Preaviso de baja: ${t.cancellationNoticeDays} días`);
  }

  // Económico
  const tax =
    t.vatRate === undefined ? '' : t.vatRate > 0 ? ` + IVA (${t.vatRate} %)` : ' (exenta de IVA)';
  header.push(`Cuota ${cycle}: ${eur(t.priceMonthly)}${tax}`);
  if (t.discountAmount && t.discountAmount > 0) {
    header.push(
      `Descuento: −${eur(t.discountAmount)} al mes${t.discountReason ? ` (${t.discountReason})` : ''}`,
    );
  }
  if (t.freeMonths && t.freeMonths > 0) {
    header.push(`Promoción: ${t.freeMonths} ${t.freeMonths === 1 ? 'mes gratis' : 'meses gratis'}`);
  }
  if (t.billingIntervalMonths && t.billingIntervalMonths > 1) {
    header.push(
      `Facturación: cada ${t.billingIntervalMonths} meses por adelantado${t.prepayDiscountPct ? ` con un descuento del ${t.prepayDiscountPct} %` : ''}`,
    );
  } else if (t.firstPaymentMonths && t.firstPaymentMonths > 1) {
    header.push(`Primer pago: ${t.firstPaymentMonths} meses por adelantado; después, ${cycle}`);
  }
  if (t.coupon) {
    header.push(
      t.coupon.freeMonths > 0
        ? `Cupón ${t.coupon.code}: ${t.coupon.freeMonths} ${t.coupon.freeMonths === 1 ? 'mes gratis' : 'meses gratis'} en el primer pago`
        : `Cupón ${t.coupon.code}: −${eur(t.coupon.discountAmount)} en el primer pago`,
    );
  }
  if (t.insurance) {
    header.push(
      `Protección de contenido: ${t.insurance.name} — ${eur(t.insurance.price)} al mes + IVA (${t.insurance.taxRate} %)`,
    );
  }
  header.push(
    `Fianza: ${eur(t.depositAmount)}${t.depositAmount > 0 ? (t.depositCash ? ' (se paga en el local, sin IVA)' : ' (sin IVA)') : ''}`,
  );

  // Cláusulas: las del tenant o las condiciones generales, entre la cabecera y
  // el consentimiento eIDAS (que siempre se conserva por su valor legal).
  const custom = t.customClauses?.trim()
    ? [
        '',
        t.defaultClauses ? 'Condiciones generales:' : 'Condiciones particulares:',
        t.customClauses.trim(),
      ]
    : [];
  const reservation = t.preOpening ? ['', ...preOpeningClauses(t, t.preOpening)] : [];
  const consent = [
    '',
    'El firmante declara haber leído y aceptado las condiciones del contrato de',
    `arrendamiento ${housing ? 'de la vivienda indicada' : 'del trastero indicado'}, reconociendo esta firma electrónica como`,
    'expresión de su consentimiento (firma electrónica simple, art. 25 Reglamento',
    'eIDAS y Ley 6/2020).',
  ];
  return [...header, ...custom, ...reservation, ...consent].join('\n');
}

/** Condiciones de la reserva antes de la apertura (se añaden a las del contrato). */
function preOpeningClauses(
  t: ContractTermsInput,
  p: NonNullable<ContractTermsInput['preOpening']>,
): string[] {
  const tax =
    t.vatRate === undefined ? '' : t.vatRate > 0 ? ` + IVA (${t.vatRate} %)` : ' (exenta de IVA)';
  return [
    'Reserva antes de la apertura del local:',
    `1. Reserva. El inquilino reserva un trastero del tipo ${p.unitTypeName}, en concreto el ${t.unitCode}. Al reservar paga la primera mensualidad, ${eur(t.priceMonthly)}${tax}, que cubre el primer mes de alquiler desde la apertura, y la fianza, ${eur(t.depositAmount)}. Si no se paga en el plazo indicado, la reserva queda sin efecto.`,
    `2. Fecha de inicio. El alquiler empieza el día de apertura del local${p.openingDate ? `, prevista aproximadamente para el ${day(p.openingDate)}` : ''}. La fecha es orientativa y puede variar; la fecha definitiva y cualquier cambio se comunicarán por correo electrónico y en el área de clientes. Hasta ese día el inquilino no tiene acceso al trastero. El precio queda fijado desde la reserva. Si el local no ha abierto el ${day(p.deadline)} (${p.maxMonths} ${p.maxMonths === 1 ? 'mes' : 'meses'} desde la reserva), el inquilino puede dejar la reserva sin efecto y recuperar todo lo pagado.`,
    '3. Cambio de trastero. Antes de la apertura, el arrendador puede asignar otro trastero del mismo local y del mismo precio, avisando al inquilino.',
    '4. Cancelación. Dentro de los 14 días siguientes a la reserva, el inquilino puede desistir y se le devuelve todo lo pagado. Pasado ese plazo y antes del día de apertura, puede cancelar la reserva: se le devuelve la primera mensualidad y la fianza queda en poder del arrendador como arras penitenciales (art. 1454 del Código Civil). Llegado el día de apertura sin cancelar, el contrato despliega todos sus efectos.',
  ];
}

/** Huella SHA-256 (hex) de un texto: la que se guarda con cada firma. */
export function termsHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const TERMS_SELECT = {
  contractNumber: true,
  priceMonthly: true,
  depositAmount: true,
  depositPaymentMethod: true,
  billingCycle: true,
  billingIntervalMonths: true,
  prepayDiscountPct: true,
  firstPaymentMonths: true,
  discountAmount: true,
  discountReason: true,
  freeMonthsRemaining: true,
  preOpening: true,
  preOpeningDateConfirmed: true,
  preOpeningDeadline: true,
  preOpeningStartedAt: true,
  startDate: true,
  endDate: true,
  autoRenew: true,
  cancellationNoticeDays: true,
  insurancePrice: true,
  insurancePlan: { select: { name: true, taxRate: true } },
  couponRedemptions: {
    take: 1,
    select: {
      months: true,
      discountAmount: true,
      freeMonths: true,
      coupon: { select: { code: true } },
    },
  },
  owner: {
    select: { legalName: true, taxId: true, address: true, city: true, postalCode: true },
  },
  customer: {
    select: {
      customerType: true,
      firstName: true,
      lastName: true,
      companyName: true,
      documentType: true,
      documentNumber: true,
      address: true,
      city: true,
      postalCode: true,
    },
  },
  unit: {
    select: {
      code: true,
      areaM2: true,
      unitType: { select: { name: true, propertyKind: true } },
      facility: {
        select: {
          name: true,
          address: true,
          city: true,
          postalCode: true,
          preOpeningMaxMonths: true,
        },
      },
    },
  },
} satisfies Prisma.ContractSelect;

const DOCUMENT_LABEL: Record<string, string> = {
  dni: 'DNI',
  nie: 'NIE',
  passport: 'Pasaporte',
  cif: 'CIF',
  nif: 'NIF',
};

function joinAddress(
  address: string | null | undefined,
  postalCode: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const place = [postalCode, city].filter(Boolean).join(' ');
  return [address, place].filter(Boolean).join(', ') || null;
}

/** Cliente de BD con lo que hace falta para componer el texto (tx o admin). */
type TermsDb = Pick<Prisma.TransactionClient, 'contract' | 'tenant'>;

/**
 * Texto completo del contrato a partir de sus datos actuales (vista de firma,
 * firma y PDF del borrador). Devuelve también las cláusulas renderizadas, que
 * se guardan aparte al firmar.
 */
export async function composeContractTerms(
  db: TermsDb,
  tenantId: string,
  contractId: string,
): Promise<{ text: string; clauses: string | null; propertyKind: string }> {
  const [c, tenant] = await Promise.all([
    db.contract.findFirstOrThrow({ where: { id: contractId, tenantId }, select: TERMS_SELECT }),
    db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        name: true,
        taxId: true,
        billingLegalName: true,
        billingAddress: true,
        billingCity: true,
        billingPostalCode: true,
        contractClauses: true,
        housingContractClauses: true,
      },
    }),
  ]);
  const propertyKind = c.unit.unitType.propertyKind ?? 'storage';
  const customerName =
    c.customer.customerType === 'business'
      ? (c.customer.companyName ?? '')
      : [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ');
  const startDate = c.startDate.toISOString().slice(0, 10);
  const tenantLegal = tenant.billingLegalName?.trim() || tenant.name;

  const template = contractClausesTemplate({
    propertyKind,
    clauses: tenant.contractClauses,
    housingClauses: tenant.housingContractClauses,
  });
  const defaultClauses = !template;
  // Mismo formato que la cabecera (y que la vista previa de la plantilla).
  const clauses = renderContractClauses(template ?? DEFAULT_STORAGE_CLAUSES, {
    contractNumber: c.contractNumber,
    customerName,
    unitCode: c.unit.code,
    facilityName: c.unit.facility.name,
    priceMonthly: eur(Number(c.priceMonthly)),
    depositAmount: eur(Number(c.depositAmount)),
    startDate: day(startDate),
    cancellationNoticeDays: String(c.cancellationNoticeDays),
    tenantName: c.owner?.legalName ?? tenantLegal,
  });

  const area = c.unit.areaM2 != null ? Number(c.unit.areaM2) : null;
  const unitDescription = [
    c.unit.unitType.name,
    area ? `${String(Math.round(area * 100) / 100).replace('.', ',')} m²` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const coupon = c.couponRedemptions[0];

  const text = buildContractTermsText({
    propertyKind,
    contractNumber: c.contractNumber,
    customerName,
    unitCode: c.unit.code,
    facilityName: c.unit.facility.name,
    priceMonthly: Number(c.priceMonthly),
    depositAmount: Number(c.depositAmount),
    billingCycle: c.billingCycle,
    startDate,
    customClauses: clauses,
    defaultClauses,
    landlord: c.owner
      ? {
          name: c.owner.legalName,
          taxId: c.owner.taxId,
          address: joinAddress(c.owner.address, c.owner.postalCode, c.owner.city),
        }
      : {
          name: tenantLegal,
          taxId: tenant.taxId,
          address: joinAddress(tenant.billingAddress, tenant.billingPostalCode, tenant.billingCity),
        },
    managedBy: c.owner ? tenantLegal : null,
    customer: {
      documentLabel: c.customer.documentType
        ? (DOCUMENT_LABEL[c.customer.documentType] ?? c.customer.documentType.toUpperCase())
        : null,
      documentNumber: c.customer.documentNumber,
      address: joinAddress(c.customer.address, c.customer.postalCode, c.customer.city),
    },
    unitDescription: unitDescription || null,
    facilityAddress: joinAddress(
      c.unit.facility.address,
      c.unit.facility.postalCode,
      c.unit.facility.city,
    ),
    endDate: c.endDate ? c.endDate.toISOString().slice(0, 10) : null,
    autoRenew: c.autoRenew,
    cancellationNoticeDays: c.cancellationNoticeDays,
    vatRate: rentTax(propertyKind).taxRate,
    discountAmount: Number(c.discountAmount),
    discountReason: c.discountReason,
    freeMonths: c.freeMonthsRemaining,
    coupon: coupon
      ? {
          code: coupon.coupon.code,
          discountAmount: Number(coupon.discountAmount),
          freeMonths: coupon.freeMonths,
          months: coupon.months,
        }
      : null,
    firstPaymentMonths: c.firstPaymentMonths,
    billingIntervalMonths: c.billingIntervalMonths,
    prepayDiscountPct: Number(c.prepayDiscountPct),
    insurance:
      c.insurancePlan && c.insurancePrice != null && Number(c.insurancePrice) > 0
        ? {
            name: c.insurancePlan.name,
            price: Number(c.insurancePrice),
            taxRate: Number(c.insurancePlan.taxRate),
          }
        : null,
    depositCash: c.depositPaymentMethod === 'cash',
    preOpening:
      c.preOpening && !c.preOpeningStartedAt
        ? {
            openingDate: c.preOpeningDateConfirmed ? startDate : null,
            deadline: (c.preOpeningDeadline ?? c.startDate).toISOString().slice(0, 10),
            maxMonths: c.unit.facility.preOpeningMaxMonths,
            unitTypeName: c.unit.unitType.name,
          }
        : null,
  });
  return { text, clauses: defaultClauses ? null : clauses, propertyKind };
}
