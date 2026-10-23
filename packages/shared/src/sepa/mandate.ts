import { z } from 'zod';

/**
 * Mandato de adeudo directo SEPA (esquema básico, CORE): el documento que firma
 * el deudor. Lleva los campos que exige el contrato de adeudos del banco
 * (cláusula 4.3) y el plazo de preaviso pactado (4.1). El mismo texto sirve
 * para el mandato de un inquilino al tenant y para el de un tenant a la
 * plataforma.
 */

export interface SepaMandateParty {
  name: string;
  address: string;
  postalCode: string;
  city: string;
  country: string;
}

export interface SepaMandateDocumentInput {
  reference: string;
  creditor: SepaMandateParty & { creditorId: string };
  debtor: SepaMandateParty;
  /** IBAN completo del deudor (se muestra enmascarado). */
  iban: string;
  bic: string | null;
  /** Días naturales de preaviso de cada adeudo pactados con el deudor. */
  prenoticeDays: number;
  /** Lugar y fecha de la firma. */
  place: string;
  date: string;
}

export interface SepaMandateDocument {
  title: string;
  fields: { label: string; value: string }[];
  clauses: string[];
}

/** «ES12 **** **** **** **** 1234»: las 4 primeras y las 4 últimas. */
export function maskIban(iban: string): string {
  const clean = iban.replace(/\s+/g, '');
  const middle = clean.slice(4, -4).replace(/./g, '*');
  return `${clean.slice(0, 4)}${middle}${clean.slice(-4)}`.replace(/(.{4})/g, '$1 ').trim();
}

function line(p: SepaMandateParty): string {
  return `${p.address}, ${p.postalCode} ${p.city} (${p.country})`;
}

export function buildSepaMandateDocument(input: SepaMandateDocumentInput): SepaMandateDocument {
  const days = input.prenoticeDays;
  return {
    title: 'Orden de domiciliación de adeudo directo SEPA',
    fields: [
      { label: 'Referencia de la orden de domiciliación', value: input.reference },
      { label: 'Identificador del acreedor', value: input.creditor.creditorId },
      { label: 'Nombre del acreedor', value: input.creditor.name },
      { label: 'Dirección del acreedor', value: line(input.creditor) },
      { label: 'Nombre del deudor', value: input.debtor.name },
      { label: 'Dirección del deudor', value: line(input.debtor) },
      { label: 'Número de cuenta (IBAN)', value: maskIban(input.iban) },
      { label: 'BIC de la entidad del deudor', value: input.bic || 'No indicado' },
      { label: 'Tipo de pago', value: 'Pago recurrente' },
      {
        label: 'Plazo de preaviso de cada adeudo',
        value: `${days} ${days === 1 ? 'día' : 'días'} naturales`,
      },
      { label: 'Lugar y fecha de la firma', value: `${input.place}, ${input.date}` },
    ],
    clauses: [
      'Mediante la firma de esta orden de domiciliación, el deudor autoriza (A) al acreedor a enviar instrucciones a la entidad del deudor para adeudar su cuenta y (B) a la entidad para efectuar los adeudos en su cuenta siguiendo las instrucciones del acreedor.',
      'Como parte de sus derechos, el deudor está legitimado al reembolso por su entidad en los términos y condiciones del contrato suscrito con la misma. La solicitud de reembolso deberá efectuarse dentro de las ocho semanas que siguen a la fecha de adeudo en cuenta. Puede obtener información adicional sobre sus derechos en su entidad financiera.',
      `El acreedor avisará al deudor del importe y la fecha de cada adeudo con al menos ${days} ${days === 1 ? 'día' : 'días'} naturales de antelación. Ambas partes acuerdan este plazo en lugar de los 14 días que fija por defecto el esquema SEPA.`,
      'El deudor debe confirmar con su entidad que los datos de esta orden de domiciliación son correctos.',
    ],
  };
}

/** Texto plano del mandato (lo que se guarda y se firma). */
export function sepaMandateText(doc: SepaMandateDocument): string {
  return [
    doc.title,
    '',
    ...doc.fields.map((f) => `${f.label}: ${f.value}`),
    '',
    ...doc.clauses,
  ].join('\n');
}

const party = {
  address: z.string().trim().min(3).max(140),
  postalCode: z.string().trim().min(3).max(16),
  city: z.string().trim().min(2).max(70),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'País en dos letras (ES)')
    .default('ES'),
};

/** Firma del mandato por el deudor (enlace del inquilino o tenant en su panel). */
export const SignSepaMandateSchema = z
  .object({
    signerName: z.string().trim().min(2).max(140),
    ...party,
    /** Lugar de la firma (ciudad). */
    place: z.string().trim().min(2).max(70),
    method: z.enum(['drawn', 'typed']),
    signatureImage: z.string().max(2_000_000).optional(),
    typedSignature: z.string().trim().max(160).optional(),
    accept: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar para firmar' }) }),
  })
  .refine((v) => (v.method === 'drawn' ? !!v.signatureImage : !!v.typedSignature?.trim()), {
    message: 'Falta la firma',
    path: ['method'],
  });
export type SignSepaMandateInput = z.infer<typeof SignSepaMandateSchema>;

/** Lo que ve el deudor antes de firmar (enlace público). */
export interface SepaMandateSignViewDto {
  /** Documento con los datos del deudor que hay hoy (los puede corregir). */
  document: SepaMandateDocument;
  creditorName: string;
  debtor: SepaMandateParty;
  ibanMasked: string;
  prenoticeDays: number;
  signed: boolean;
}

/** Estado de la firma del mandato. `external`: firmado fuera de la app (papel o migrado). */
export type SepaMandateSignatureStatus = 'pending' | 'signed' | 'external';

/** El mandato ya cuenta para cobrar (firmado aquí o fuera). */
export function mandateIsSigned(status: string): boolean {
  return status === 'signed' || status === 'external';
}
