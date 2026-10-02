import { createHash } from 'node:crypto';

/**
 * Huella Veri*Factu de un registro de alta, según las especificaciones
 * técnicas de la AEAT («Detalle de las especificaciones técnicas para la
 * generación de la huella o hash de los registros»):
 *
 *   IDEmisorFactura=…&NumSerieFactura=…&FechaExpedicionFactura=DD-MM-AAAA
 *   &TipoFactura=…&CuotaTotal=…&ImporteTotal=…&Huella=<anterior>
 *   &FechaHoraHusoGenRegistro=AAAA-MM-DDThh:mm:ss+hh:mm
 *
 * SHA-256 en UTF-8, hexadecimal en mayúsculas. Los importes van con el
 * mismo formato que en el XML (dos decimales, punto). En el primer registro
 * de la cadena `Huella=` va vacío. La cadena es POR EMISOR (NIF), no por serie.
 */
export interface AltaHashInput {
  emitterTaxId: string;
  invoiceNumber: string;
  /** Fecha de expedición en formato DD-MM-AAAA. */
  issueDate: string;
  invoiceType: string;
  cuotaTotal: number;
  importeTotal: number;
  /** Huella del registro anterior del emisor; null en el primero. */
  previousHash: string | null;
  /** FechaHoraHusoGenRegistro exacta que irá en el XML. */
  recordTimestamp: string;
}

export function altaHashInput(i: AltaHashInput): string {
  return [
    `IDEmisorFactura=${i.emitterTaxId.trim()}`,
    `NumSerieFactura=${i.invoiceNumber.trim()}`,
    `FechaExpedicionFactura=${i.issueDate.trim()}`,
    `TipoFactura=${i.invoiceType.trim()}`,
    `CuotaTotal=${i.cuotaTotal.toFixed(2)}`,
    `ImporteTotal=${i.importeTotal.toFixed(2)}`,
    `Huella=${(i.previousHash ?? '').trim().toUpperCase()}`,
    `FechaHoraHusoGenRegistro=${i.recordTimestamp.trim()}`,
  ].join('&');
}

export function computeAltaHash(i: AltaHashInput): string {
  return createHash('sha256').update(altaHashInput(i), 'utf8').digest('hex').toUpperCase();
}
