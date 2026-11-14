import { createHash } from 'node:crypto';

import {
  DEFAULT_STORAGE_CLAUSES,
  contractClausesTemplate,
  moveOutRuleText,
  renderContractClauses,
  rentTax,
} from '@storageos/shared';

import { BOOKING_HOLD_HOURS } from '../../common/online-booking';

import type { Prisma } from '@storageos/database';

/** Datos de una parte del contrato (arrendador o inquilino). */
interface PartyInput {
  name: string;
  taxId?: string | null;
  address?: string | null;
}

export interface ContractTermsInput {
  /**
   * Reserva online (sin local por abrir): el contrato entra en vigor con el
   * primer pago; sin él, en estas horas queda sin efecto.
   */
  paymentHoldHours?: number | null;
  /** Reserva antes de la apertura del local (aún sin empezar). */
  preOpening?: {
    /** Fecha de apertura prevista (`YYYY-MM-DD`), o null si aún no está fijada. */
    openingDate: string | null;
    /**
     * Meses desde la reserva tras los que, sin abrir, se puede cancelar con
     * devolución total. Se dice en meses y no con la fecha límite: sin fecha de
     * apertura, esa fecha lejana se leía como la de inicio.
     */
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
  /** Condiciones propias de este contrato (tras las generales). */
  specificConditions?: string | null;
  /** true = son las condiciones generales por defecto (no las del tenant). */
  defaultClauses?: boolean;
  /** `housing` = contrato de vivienda. */
  propertyKind?: string | null;
  /** Quién alquila (el negocio o el propietario del local). */
  landlord?: PartyInput | null;
  /** Negocio que gestiona el local en nombre del propietario. */
  managedBy?: string | null;
  /** Correo y teléfono para las comunicaciones del contrato (arrendador o gestor). */
  landlordContact?: string | null;
  /** Documento, domicilio y contacto del inquilino. */
  customer?: {
    documentLabel?: string | null;
    documentNumber?: string | null;
    address?: string | null;
    email?: string | null;
    phone?: string | null;
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
  /** Días máximos para devolver la fianza desde la entrega. */
  depositReturnDays?: number;
  /** La baja surte efecto el último día del mes en que se cumple el preaviso. */
  moveOutEndOfMonth?: boolean;
  /** Horario de acceso al local (texto ya compuesto). */
  accessHours?: string | null;
  /**
   * Recargo por demora y gastos por recibo devuelto (sin IVA). Si se indican
   * (aunque sea null), la ficha dice cuáles se aplican, o que no hay ninguno.
   */
  lateFee?: { type: string; value: number; graceDays: number } | null;
  returnedPaymentFee?: number | null;
  /**
   * A quién se dirige el modelo de formulario de desistimiento (nombre,
   * domicilio y correo). Solo con un particular en un trastero: la ley excluye
   * el alquiler de vivienda (art. 93 TRLGDCU).
   */
  withdrawalFormTo?: string | null;
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

/** Importe con IVA en céntimos (mismo redondeo que las líneas de factura). */
function grossCents(base: number, rate: number): number {
  return Math.round((Math.round(base * 100) * (100 + rate)) / 100);
}

/**
 * `75,00 €` → `90,75 € IVA incluido (75,00 € + IVA del 21 %)`; con `per`:
 * `5,45 € al mes, IVA incluido (…)`. Exento: `500,00 € (exenta de IVA)`.
 */
function priceWithVat(base: number, rate: number | undefined, per?: string): string {
  const when = per ? ` ${per}` : '';
  if (rate === undefined) return `${eur(base)}${when}`;
  if (rate <= 0) return `${eur(base)}${when} (exenta de IVA)`;
  return `${eur(grossCents(base, rate) / 100)}${when}${per ? ',' : ''} IVA incluido (${eur(base)} + IVA del ${rate} %)`;
}

/** Importe con el IVA sumado y la coletilla (`6,05 € al mes, IVA incluido`). */
function grossWithVat(base: number, rate: number | undefined, per: string): string {
  if (rate === undefined || rate <= 0) return `${eur(base)} ${per}`;
  return `${eur(grossCents(base, rate) / 100)} ${per}, IVA incluido`;
}

/**
 * Horario de acceso a partir del toque de queda del local (`HH:MM`, la
 * franja en la que NO se puede entrar). Sin toque de queda: el publicado.
 */
export function accessHoursText(curfew: {
  enabled: boolean;
  start: string | null;
  end: string | null;
}): string {
  const valid = (v: string | null): v is string => !!v && /^\d{2}:\d{2}$/.test(v);
  if (
    !curfew.enabled ||
    !valid(curfew.start) ||
    !valid(curfew.end) ||
    curfew.start === curfew.end
  ) {
    return 'el publicado para el local';
  }
  return curfew.start > curfew.end
    ? `de ${curfew.end} a ${curfew.start}, todos los días`
    : `todos los días, salvo de ${curfew.start} a ${curfew.end}`;
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
  if (t.landlordContact) header.push(`Contacto para este contrato: ${t.landlordContact}`);
  const customerParts = [
    t.customerName,
    t.customer?.documentNumber
      ? `${t.customer.documentLabel || 'Documento'} ${t.customer.documentNumber}`
      : null,
    t.customer?.address || null,
    t.customer?.email || null,
    t.customer?.phone || null,
  ].filter(Boolean);
  header.push(`Inquilino: ${customerParts.join(' · ')}`);
  header.push(
    `${unitWord}: ${t.unitCode}${t.unitDescription ? ` (${t.unitDescription})` : ''} — ${t.facilityName}${t.facilityAddress ? `, ${t.facilityAddress}` : ''}`,
  );

  // Duración
  const delivery = `Inicio y entrega ${housing ? 'de la vivienda' : 'del trastero'}`;
  header.push(
    t.preOpening
      ? `${delivery}: el día de apertura del local${t.preOpening.openingDate ? ` (prevista aproximadamente para el ${day(t.preOpening.openingDate)})` : ' (fecha aún por confirmar)'}`
      : `${delivery}: ${day(t.startDate)}`,
  );
  if (t.paymentHoldHours && !t.preOpening) {
    header.push(
      `Entrada en vigor: con el primer pago. Si no se recibe en las ${t.paymentHoldHours} horas siguientes a la reserva (o en el plazo ampliado que se comunique), el contrato queda sin efecto, sin coste para el inquilino, y ${housing ? 'la vivienda' : 'el trastero'} vuelve a estar libre`,
    );
  }
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
    header.push(
      `Preaviso de baja: ${t.cancellationNoticeDays} días${
        t.moveOutEndOfMonth ? '; la baja surte efecto a final de mes' : ''
      }`,
    );
  }

  // Económico: con el IVA incluido, que es lo que paga un consumidor.
  header.push(`Cuota ${cycle}: ${priceWithVat(t.priceMonthly, t.vatRate)}`);
  const discount = t.discountAmount && t.discountAmount > 0 ? t.discountAmount : 0;
  if (discount > 0) {
    header.push(
      `Descuento: −${grossWithVat(discount, t.vatRate, 'al mes')}${t.discountReason ? ` (${t.discountReason})` : ''}`,
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
  if (
    (t.billingIntervalMonths && t.billingIntervalMonths > 1) ||
    (t.firstPaymentMonths && t.firstPaymentMonths > 1)
  ) {
    header.push(PREPAID_EARLY_END_LINE);
  }
  if (t.coupon) {
    header.push(
      t.coupon.freeMonths > 0
        ? `Cupón ${t.coupon.code}: ${t.coupon.freeMonths} ${t.coupon.freeMonths === 1 ? 'mes gratis' : 'meses gratis'} en el primer pago`
        : `Cupón ${t.coupon.code}: −${grossWithVat(t.coupon.discountAmount, t.vatRate, 'en el primer pago')}`,
    );
  }
  if (t.insurance) {
    header.push(
      `Protección de contenido: ${t.insurance.name} — ${priceWithVat(t.insurance.price, t.insurance.taxRate, 'al mes')}`,
    );
  }
  if (t.vatRate !== undefined && (discount > 0 || t.insurance)) {
    const total =
      grossCents(t.priceMonthly - discount, t.vatRate) +
      (t.insurance ? grossCents(t.insurance.price, t.insurance.taxRate) : 0);
    const anyVat = t.vatRate > 0 || (t.insurance?.taxRate ?? 0) > 0;
    header.push(`Total al mes: ${eur(total / 100)}${anyVat ? ' IVA incluido' : ''}`);
  }
  header.push(
    `Fianza: ${eur(t.depositAmount)}${
      t.depositAmount > 0 ? (t.depositCash ? ' (se paga en el local, sin IVA)' : ' (sin IVA)') : ''
    }${
      t.depositAmount > 0 && t.depositReturnDays
        ? `; se devuelve en un plazo máximo de ${t.depositReturnDays} días desde la entrega ${housing ? 'de la vivienda' : 'del trastero'}`
        : ''
    }`,
  );
  if (!housing && t.accessHours) header.push(`Horario de acceso: ${t.accessHours}`);
  if (t.lateFee !== undefined || t.returnedPaymentFee !== undefined) {
    if (!t.lateFee && !t.returnedPaymentFee) {
      header.push('Recargos por impago: ninguno');
    }
    if (t.lateFee) {
      header.push(
        `Recargo por demora: ${
          t.lateFee.type === 'fixed'
            ? `${eur(t.lateFee.value)} por factura vencida`
            : `${t.lateFee.value} % de lo pendiente de la factura vencida`
        }, pasados ${t.lateFee.graceDays} días de su vencimiento (sin IVA)`,
      );
    }
    if (t.returnedPaymentFee) {
      header.push(
        `Gastos por recibo devuelto o pago rechazado: ${eur(t.returnedPaymentFee)} cada uno (sin IVA)`,
      );
    }
  }

  // Cláusulas: las del tenant o las condiciones generales, entre la cabecera y
  // el consentimiento eIDAS (que siempre se conserva por su valor legal).
  const custom = t.customClauses?.trim()
    ? [
        '',
        t.defaultClauses ? 'Condiciones generales:' : 'Condiciones particulares:',
        t.customClauses.trim(),
      ]
    : [];
  const specific = t.specificConditions?.trim()
    ? ['', 'Condiciones específicas de este contrato:', t.specificConditions.trim()]
    : [];
  const reservation = t.preOpening ? ['', ...preOpeningClauses(t, t.preOpening)] : [];
  const withdrawalForm = t.withdrawalFormTo
    ? [
        '',
        'Modelo de formulario de desistimiento (solo si quiere desistir del contrato; también puede hacerlo desde el área de clientes):',
        `A la atención de ${t.withdrawalFormTo}:`,
        `Por la presente le comunico que desisto de mi contrato de prestación del siguiente servicio: alquiler del trastero ${t.unitCode} (contrato ${t.contractNumber}).`,
        'Celebrado el: ________',
        'Nombre del consumidor: ________',
        'Domicilio del consumidor: ________',
        'Firma del consumidor (solo si el presente formulario se presenta en papel): ________',
        'Fecha: ________',
      ]
    : [];
  const consent = [
    '',
    'El firmante declara haber leído y aceptado las condiciones del contrato de',
    `arrendamiento ${housing ? 'de la vivienda indicada' : 'del trastero indicado'}, reconociendo esta firma electrónica como`,
    'expresión de su consentimiento (firma electrónica simple, art. 25 Reglamento',
    'eIDAS y Ley 6/2020).',
  ];
  return [...header, ...custom, ...specific, ...reservation, ...withdrawalForm, ...consent].join(
    '\n',
  );
}

/** Condiciones de la reserva antes de la apertura (se añaden a las del contrato). */
function preOpeningClauses(
  t: ContractTermsInput,
  p: NonNullable<ContractTermsInput['preOpening']>,
): string[] {
  return [
    'Reserva antes de la apertura del local:',
    `1. Reserva. El inquilino reserva un trastero del tipo ${p.unitTypeName}, en concreto el ${t.unitCode}. Al reservar paga la primera mensualidad, ${priceWithVat(t.priceMonthly, t.vatRate)}, que cubre el primer mes de alquiler desde la apertura, y la fianza, ${eur(t.depositAmount)}. Si no se paga en el plazo indicado, la reserva queda sin efecto.`,
    `2. Fecha de inicio. El alquiler empieza el día de apertura del local${p.openingDate ? `, prevista aproximadamente para el ${day(p.openingDate)}` : ''}. La fecha es orientativa y puede variar; la fecha definitiva y cualquier cambio se comunicarán por correo electrónico y en el área de clientes. Hasta ese día el inquilino no tiene acceso al trastero. El precio queda fijado desde la reserva. Si ${p.maxMonths === 1 ? 'pasado un mes' : `pasados ${p.maxMonths} meses`} desde la reserva el local aún no ha abierto, el inquilino puede dejar la reserva sin efecto y recuperar todo lo pagado.`,
    '3. Cambio de trastero. Antes de la apertura, el arrendador puede asignar otro trastero del mismo local y del mismo precio, avisando al inquilino.',
    '4. Cancelación. Dentro de los 14 días siguientes a la reserva, el inquilino puede desistir y se le devuelve todo lo pagado. Pasado ese plazo y antes del día de apertura, puede cancelar la reserva: se le devuelve la primera mensualidad y la fianza queda en poder del arrendador como arras penitenciales (art. 1454 del Código Civil). Llegado el día de apertura sin cancelar, el contrato despliega todos sus efectos.',
  ];
}

/**
 * Lo que pasa con lo pagado por adelantado si el inquilino se va antes. Va en la
 * ficha de todo contrato con pago de varios meses que se firme desde el contrato
 * v2 (con las cláusulas propias del negocio o con las generales).
 */
export const PREPAID_EARLY_END_LINE =
  'Baja antes de usar lo pagado por adelantado: se devuelven los meses enteros sin usar; los usados se cobran a la cuota mensual, sin el descuento ni los meses gratis de ese pago';

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
  preOpeningStartedAt: true,
  firstPaymentDeadline: true,
  startDate: true,
  endDate: true,
  autoRenew: true,
  cancellationNoticeDays: true,
  specificConditions: true,
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
      email: true,
      phone: true,
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
          contactEmail: true,
          contactPhone: true,
          accessCurfewEnabled: true,
          accessCurfewStart: true,
          accessCurfewEnd: true,
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
  /** Firma a distancia de un particular: lleva el modelo de formulario de desistimiento. */
  opts: { withdrawalForm?: boolean } = {},
): Promise<{
  text: string;
  clauses: string | null;
  propertyKind: string;
  /** La baja surte efecto a final de mes (lo que dice este texto; se guarda al firmar). */
  moveOutEndOfMonth: boolean;
}> {
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
        contactEmail: true,
        contactPhone: true,
        billingEmail: true,
        lateFeeEnabled: true,
        lateFeeType: true,
        lateFeeValue: true,
        lateFeeGraceDays: true,
        returnedPaymentFee: true,
        depositReturnDays: true,
        moveOutEndOfMonth: true,
      },
    }),
  ]);
  const propertyKind = c.unit.unitType.propertyKind ?? 'storage';
  // La baja a final de mes es de los trasteros; una vivienda sigue su ley (LAU).
  const moveOutEndOfMonth = propertyKind !== 'housing' && tenant.moveOutEndOfMonth;
  const customerName =
    c.customer.customerType === 'business'
      ? (c.customer.companyName ?? '')
      : [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ');
  const startDate = c.startDate.toISOString().slice(0, 10);
  // Reserva antes de la apertura sin fecha: la guardada es la fecha límite, no la
  // de inicio, y en el contrato no se pone ninguna.
  const openingPending = !!c.preOpening && !c.preOpeningStartedAt && !c.preOpeningDateConfirmed;
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
    startDate: openingPending ? 'día de apertura del local' : day(startDate),
    cancellationNoticeDays: String(c.cancellationNoticeDays),
    tenantName: c.owner?.legalName ?? tenantLegal,
    moveOutRule: moveOutRuleText(moveOutEndOfMonth),
    depositReturnDays: String(tenant.depositReturnDays),
  });
  const facility = c.unit.facility;
  const landlordContact =
    [
      facility.contactEmail || tenant.contactEmail || tenant.billingEmail,
      facility.contactPhone || tenant.contactPhone,
    ]
      .filter(Boolean)
      .join(' · ') || null;
  const returnedPaymentFee =
    tenant.returnedPaymentFee != null && Number(tenant.returnedPaymentFee) > 0
      ? Number(tenant.returnedPaymentFee)
      : null;
  const landlordName = c.owner?.legalName ?? tenantLegal;
  const landlordAddress = c.owner
    ? joinAddress(c.owner.address, c.owner.postalCode, c.owner.city)
    : joinAddress(tenant.billingAddress, tenant.billingPostalCode, tenant.billingCity);
  const contactEmail = facility.contactEmail || tenant.contactEmail || tenant.billingEmail;
  const withdrawalFormTo =
    opts.withdrawalForm && propertyKind !== 'housing' && c.customer.customerType !== 'business'
      ? [landlordName, landlordAddress, contactEmail].filter(Boolean).join(', ')
      : null;

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
    specificConditions: c.specificConditions,
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
      email: c.customer.email,
      phone: c.customer.phone,
    },
    landlordContact,
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
    depositReturnDays: tenant.depositReturnDays,
    moveOutEndOfMonth,
    accessHours: accessHoursText({
      enabled: facility.accessCurfewEnabled,
      start: facility.accessCurfewStart,
      end: facility.accessCurfewEnd,
    }),
    lateFee: tenant.lateFeeEnabled
      ? {
          type: tenant.lateFeeType,
          value: Number(tenant.lateFeeValue),
          graceDays: tenant.lateFeeGraceDays,
        }
      : null,
    returnedPaymentFee,
    withdrawalFormTo,
    // Reserva online: el contrato entra en vigor con el primer pago.
    paymentHoldHours: c.firstPaymentDeadline ? BOOKING_HOLD_HOURS : null,
    preOpening:
      c.preOpening && !c.preOpeningStartedAt
        ? {
            openingDate: c.preOpeningDateConfirmed ? startDate : null,
            maxMonths: c.unit.facility.preOpeningMaxMonths,
            unitTypeName: c.unit.unitType.name,
          }
        : null,
  });
  return { text, clauses: defaultClauses ? null : clauses, propertyKind, moveOutEndOfMonth };
}
