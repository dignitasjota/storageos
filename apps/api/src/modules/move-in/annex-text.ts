/**
 * Texto de un anexo a un contrato firmado. Las partes y el trastero se toman
 * del texto que se firmó (las mismas líneas), para que el anexo diga lo mismo
 * que el contrato aunque después hayan cambiado los datos de la ficha.
 */
const PARTY_LINE = /^(Arrendador|Gestionado por|Inquilino|Trastero|Vivienda):/;

export function buildAnnexText(a: {
  number: number;
  title: string;
  body: string;
  contractNumber: string;
  /** Texto que se firmó del contrato (null si se firmó antes de guardarlo). */
  signedContractText: string | null;
  customerName: string;
  unitCode: string;
  facilityName: string;
  /** Fecha del anexo, `dd/mm/aaaa`. */
  date: string;
}): string {
  // Solo la cabecera del contrato (hasta la primera línea en blanco): el pie
  // repite al arrendador y al inquilino en otra forma.
  const lines = (a.signedContractText ?? '').split('\n');
  const blank = lines.findIndex((line) => line.trim() === '');
  const fromContract = (blank >= 0 ? lines.slice(0, blank) : lines).filter((line) =>
    PARTY_LINE.test(line),
  );
  const parties =
    fromContract.length > 0
      ? fromContract
      : [`Inquilino: ${a.customerName}`, `Trastero: ${a.unitCode} — ${a.facilityName}`];
  return [
    `Anexo ${a.number} al contrato de alquiler ${a.contractNumber}`,
    `Asunto: ${a.title.trim()}`,
    `Fecha: ${a.date}`,
    ...parties,
    '',
    'Las partes acuerdan añadir al contrato lo siguiente:',
    a.body.trim(),
    '',
    'En todo lo demás, el contrato sigue igual.',
    '',
    'El firmante declara haber leído y aceptado este anexo, reconociendo esta firma',
    'electrónica como expresión de su consentimiento (firma electrónica simple,',
    'art. 25 Reglamento eIDAS y Ley 6/2020).',
  ].join('\n');
}
