import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../../config/env.schema';

/**
 * Construye el XML SOAP de un `RegistroAlta` Veri*Factu listo para enviar
 * al endpoint AEAT. Sigue la estructura definida en
 * `RegFactuSistemaFacturacion.xsd` v1.0 (RD 1007/2023).
 *
 * Notas de diseno:
 *
 * - Modo Veri*Factu (verificable), NO SII. Por tanto el bloque
 *   `<sum:Cabecera>` solo incluye `<sum1:ObligadoEmision>` y no hay
 *   firma XAdES obligatoria (la confianza viene del hash encadenado).
 * - El XML es construido por concatenacion controlada con escape
 *   exhaustivo (`escapeXml`) en TODOS los strings inyectados. Es la
 *   principal defensa contra XML injection: nombres, descripciones y
 *   NIFs del cliente pueden contener `<`, `>`, `&`, `"`, `'`.
 * - Los namespaces siguen los que publica AEAT en el WSDL:
 *   - `sum`  -> SuministroLR.xsd (envoltorio de "suministro" de
 *     registros)
 *   - `sum1` -> SuministroInformacion.xsd (tipos comunes y campos del
 *     registro en si)
 * - `FechaExpedicionFactura` va en formato `DD-MM-YYYY` segun spec AEAT
 *   (formato espanol, no ISO).
 * - `FechaHoraHusoGenRegistro` va en ISO 8601 con timezone Europe/Madrid
 *   explicito (`+01:00` o `+02:00` segun horario de verano), calculado
 *   con `Intl.DateTimeFormat`.
 * - `Huella` y `previousHash` se serializan en MAYUSCULAS por convencion
 *   AEAT (los XSD aceptan tanto mayus como minus pero la respuesta oficial
 *   siempre es en mayus).
 */
@Injectable()
export class VerifactuXmlBuilder {
  constructor(private readonly config: ConfigService<Env, true>) {}

  buildRegistroAlta(args: BuildRegistroAltaArgs): string {
    const { tenant, invoice, recipient } = args;

    const sistemaNif = escapeXml(this.config.get('AEAT_SISTEMA_NIF', { infer: true }));
    const sistemaNombre = escapeXml(this.config.get('AEAT_SISTEMA_NOMBRE', { infer: true }));
    const sistemaVersion = escapeXml(this.config.get('AEAT_SISTEMA_VERSION', { infer: true }));
    const sistemaInstalacion = escapeXml(
      this.config.get('AEAT_SISTEMA_INSTALACION', { infer: true }),
    );

    const tenantName = escapeXml(tenant.name);
    const tenantNif = escapeXml(tenant.taxId);
    const invoiceNumber = escapeXml(invoice.invoiceNumber);
    const issueDate = formatSpanishDate(invoice.issueDate);
    const description = escapeXml(invoice.description);
    const invoiceType = escapeXml(invoice.invoiceType);

    // F2 sin destinatario: AEAT define el flag
    // `<FacturaSinIdentifDestinatarioArt61d>S</...>` para indicar que
    // estamos emitiendo una simplificada sin identificacion del cliente.
    // El bloque `<Destinatarios>` se omite por completo en ese caso.
    const isSimplifiedWithoutRecipient = invoice.invoiceType === 'F2' && !recipient;
    const destinatariosBlock = isSimplifiedWithoutRecipient
      ? `          <sum1:FacturaSinIdentifDestinatarioArt61d>S</sum1:FacturaSinIdentifDestinatarioArt61d>`
      : recipient
        ? `          <sum1:Destinatarios>
            <sum1:IDDestinatario>
              <sum1:NombreRazon>${escapeXml(recipient.name)}</sum1:NombreRazon>
              <sum1:NIF>${escapeXml(recipient.taxId)}</sum1:NIF>
            </sum1:IDDestinatario>
          </sum1:Destinatarios>`
        : `          <sum1:FacturaSinIdentifDestinatarioArt61d>S</sum1:FacturaSinIdentifDestinatarioArt61d>`;

    const subtotal = invoice.subtotal.toFixed(2);
    const taxRate = invoice.taxRate.toFixed(2);
    const taxAmount = invoice.taxAmount.toFixed(2);
    const total = invoice.total.toFixed(2);
    const huella = invoice.hash.toUpperCase();

    const encadenamiento = invoice.previousHash
      ? this.buildRegistroAnterior({
          previousHash: invoice.previousHash,
          previousInvoiceNumber: invoice.previousInvoiceNumber ?? '',
          previousInvoiceDate: invoice.previousInvoiceDate ?? null,
          previousEmitterNif: invoice.previousEmitterNif ?? tenant.taxId,
        })
      : `          <sum1:PrimerRegistro>S</sum1:PrimerRegistro>`;

    // Bloques especificos de rectificativas (R1-R5). Se ubican entre
    // `Destinatarios` y `Desglose` segun el XSD AEAT.
    const isRectification = invoice.invoiceType.startsWith('R');
    const includeOriginalAmounts =
      invoice.correctionMethod === 'S' && invoice.originalAmounts !== undefined;
    const rectificationBlocks = isRectification
      ? this.buildRectificationBlocks({
          correctionMethod: invoice.correctionMethod ?? 'I',
          rectifies: invoice.rectifies ?? [],
          ...(includeOriginalAmounts ? { originalAmounts: invoice.originalAmounts! } : {}),
        })
      : '';

    const generadoEn = formatTimestampWithMadridTimezone(new Date());

    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sum="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd" xmlns:sum1="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd">
  <soapenv:Header/>
  <soapenv:Body>
    <sum:RegFactuSistemaFacturacion>
      <sum:Cabecera>
        <sum1:ObligadoEmision>
          <sum1:NombreRazon>${tenantName}</sum1:NombreRazon>
          <sum1:NIF>${tenantNif}</sum1:NIF>
        </sum1:ObligadoEmision>
      </sum:Cabecera>
      <sum:RegistroFactura>
        <sum:RegistroAlta>
          <sum1:IDVersion>1.0</sum1:IDVersion>
          <sum1:IDFactura>
            <sum1:IDEmisorFactura>${tenantNif}</sum1:IDEmisorFactura>
            <sum1:NumSerieFactura>${invoiceNumber}</sum1:NumSerieFactura>
            <sum1:FechaExpedicionFactura>${issueDate}</sum1:FechaExpedicionFactura>
          </sum1:IDFactura>
          <sum1:NombreRazonEmisor>${tenantName}</sum1:NombreRazonEmisor>
          <sum1:TipoFactura>${invoiceType}</sum1:TipoFactura>
          <sum1:DescripcionOperacion>${description}</sum1:DescripcionOperacion>
${destinatariosBlock}${rectificationBlocks}
          <sum1:Desglose>
            <sum1:DetalleDesglose>
              <sum1:Impuesto>01</sum1:Impuesto>
              <sum1:ClaveRegimen>01</sum1:ClaveRegimen>
              <sum1:CalificacionOperacion>S1</sum1:CalificacionOperacion>
              <sum1:TipoImpositivo>${taxRate}</sum1:TipoImpositivo>
              <sum1:BaseImponibleOimporteNoSujeto>${subtotal}</sum1:BaseImponibleOimporteNoSujeto>
              <sum1:CuotaRepercutida>${taxAmount}</sum1:CuotaRepercutida>
            </sum1:DetalleDesglose>
          </sum1:Desglose>
          <sum1:CuotaTotal>${taxAmount}</sum1:CuotaTotal>
          <sum1:ImporteTotal>${total}</sum1:ImporteTotal>
          <sum1:Encadenamiento>
${encadenamiento}
          </sum1:Encadenamiento>
          <sum1:SistemaInformatico>
            <sum1:NombreRazon>${sistemaNombre}</sum1:NombreRazon>
            <sum1:NIF>${sistemaNif}</sum1:NIF>
            <sum1:NombreSistemaInformatico>${sistemaNombre}</sum1:NombreSistemaInformatico>
            <sum1:IdSistemaInformatico>01</sum1:IdSistemaInformatico>
            <sum1:Version>${sistemaVersion}</sum1:Version>
            <sum1:NumeroInstalacion>${sistemaInstalacion}</sum1:NumeroInstalacion>
            <sum1:TipoUsoPosibleSoloVerifactu>S</sum1:TipoUsoPosibleSoloVerifactu>
            <sum1:TipoUsoPosibleMultiOT>S</sum1:TipoUsoPosibleMultiOT>
            <sum1:IndicadorMultiplesOT>N</sum1:IndicadorMultiplesOT>
          </sum1:SistemaInformatico>
          <sum1:FechaHoraHusoGenRegistro>${generadoEn}</sum1:FechaHoraHusoGenRegistro>
          <sum1:TipoHuella>01</sum1:TipoHuella>
          <sum1:Huella>${huella}</sum1:Huella>
        </sum:RegistroAlta>
      </sum:RegistroFactura>
    </sum:RegFactuSistemaFacturacion>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * Bloques especificos para facturas rectificativas (R1-R5):
   *
   *   <TipoRectificativa>I|S</TipoRectificativa>
   *   <FacturasRectificadas>
   *     <IDFacturaAnterior>
   *       <IDEmisorFactura>...</IDEmisorFactura>
   *       <NumSerieFactura>...</NumSerieFactura>
   *       <FechaExpedicionFactura>DD-MM-YYYY</FechaExpedicionFactura>
   *     </IDFacturaAnterior>
   *     ... (puede repetirse; MVP solo emite 1)
   *   </FacturasRectificadas>
   *   <ImporteRectificacion>  -- solo en sustitucion (S)
   *     <BaseRectificada>...</BaseRectificada>
   *     <CuotaRectificada>...</CuotaRectificada>
   *     <CuotaRecargoRectificado>...</CuotaRecargoRectificado>
   *   </ImporteRectificacion>
   *
   * NOTA: el `TipoFactura` (R1..R5) se emite siempre en el campo principal
   * del registro; aqui solo emitimos los bloques adicionales que solo
   * aplican a rectificativas. Si `rectifies` viene vacio el bloque
   * `FacturasRectificadas` se omite (XSD lo permite, AEAT puede aceptar
   * sin lista cuando no se identifican concretamente).
   *
   * En sustitucion (`correctionMethod='S'`) el campo
   * `<ImporteRectificacion>` lleva los totales ORIGINALES de la factura
   * rectificada (no los nuevos): asi AEAT sabe que estamos sustituyendo
   * esos importes por los del nuevo registro.
   */
  private buildRectificationBlocks(args: {
    correctionMethod: 'I' | 'S';
    rectifies: ReadonlyArray<{ emitterTaxId: string; invoiceNumber: string; issueDate: Date }>;
    originalAmounts?: { baseRectificada: number; cuotaRectificada: number; recargo?: number };
  }): string {
    const tipoRect = args.correctionMethod === 'S' ? 'S' : 'I';
    const items = args.rectifies
      .map((r) => {
        const nif = escapeXml(r.emitterTaxId);
        const num = escapeXml(r.invoiceNumber);
        const fecha = formatSpanishDate(r.issueDate);
        return `              <sum1:IDFacturaAnterior>
                <sum1:IDEmisorFactura>${nif}</sum1:IDEmisorFactura>
                <sum1:NumSerieFactura>${num}</sum1:NumSerieFactura>
                <sum1:FechaExpedicionFactura>${fecha}</sum1:FechaExpedicionFactura>
              </sum1:IDFacturaAnterior>`;
      })
      .join('\n');
    const facturasRectificadas = items
      ? `
            <sum1:FacturasRectificadas>
${items}
            </sum1:FacturasRectificadas>`
      : '';

    // `<ImporteRectificacion>` solo aplica en sustitucion. AEAT exige
    // BaseRectificada + CuotaRectificada; CuotaRecargoRectificado es
    // opcional (recargo de equivalencia). El bloque va DESPUES de
    // FacturasRectificadas y ANTES de Desglose.
    let importeRectificacion = '';
    if (args.correctionMethod === 'S' && args.originalAmounts) {
      const base = args.originalAmounts.baseRectificada.toFixed(2);
      const cuota = args.originalAmounts.cuotaRectificada.toFixed(2);
      const recargo = (args.originalAmounts.recargo ?? 0).toFixed(2);
      importeRectificacion = `
            <sum1:ImporteRectificacion>
              <sum1:BaseRectificada>${base}</sum1:BaseRectificada>
              <sum1:CuotaRectificada>${cuota}</sum1:CuotaRectificada>
              <sum1:CuotaRecargoRectificado>${recargo}</sum1:CuotaRecargoRectificado>
            </sum1:ImporteRectificacion>`;
    }

    return `
          <sum1:TipoRectificativa>${tipoRect}</sum1:TipoRectificativa>${facturasRectificadas}${importeRectificacion}`;
  }

  private buildRegistroAnterior(args: {
    previousHash: string;
    previousInvoiceNumber: string;
    previousInvoiceDate: Date | null;
    previousEmitterNif: string;
  }): string {
    const num = escapeXml(args.previousInvoiceNumber);
    const nif = escapeXml(args.previousEmitterNif);
    const fecha = args.previousInvoiceDate ? formatSpanishDate(args.previousInvoiceDate) : '';
    const huella = args.previousHash.toUpperCase();
    return `          <sum1:RegistroAnterior>
            <sum1:IDEmisorFactura>${nif}</sum1:IDEmisorFactura>
            <sum1:NumSerieFactura>${num}</sum1:NumSerieFactura>
            <sum1:FechaExpedicionFactura>${fecha}</sum1:FechaExpedicionFactura>
            <sum1:Huella>${huella}</sum1:Huella>
          </sum1:RegistroAnterior>`;
  }
}

// --------------------------------------------------------------------------
// Tipos publicos
// --------------------------------------------------------------------------

export interface BuildRegistroAltaArgs {
  tenant: {
    /** Razon social del emisor. */
    name: string;
    /** NIF del emisor. */
    taxId: string;
  };
  invoice: {
    /** Serie de facturacion (ej. `F`). */
    series: string;
    /** Numero completo (`F-2026-0001`). */
    invoiceNumber: string;
    issueDate: Date;
    /** Fecha de operacion si distinta a `issueDate`. Reservado para uso futuro. */
    operationDate?: Date;
    description: string;
    /**
     * F1 = factura completa, F2 = simplificada (post-MVP), R1-R5 =
     * rectificativa (RD 1619/2012 art. 13). Si `invoiceType` empieza por
     * `R`, el XML emite los bloques `<TipoRectificativa>` y opcionalmente
     * `<FacturasRectificadas>` con el contenido de `rectifies`.
     */
    invoiceType: 'F1' | 'F2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
    /**
     * Lista de facturas originales que rectifica esta rectificativa. Solo
     * tiene sentido cuando `invoiceType` es R1..R5. En MVP `InvoicesService`
     * solo emite 1 entrada (no soportamos rectificativas multi-original).
     */
    rectifies?: ReadonlyArray<{
      emitterTaxId: string;
      invoiceNumber: string;
      issueDate: Date;
    }>;
    /**
     * Metodo de rectificacion: `I` por diferencias, `S` por sustitucion.
     * Default `I` cuando se omite.
     */
    correctionMethod?: 'I' | 'S';
    /**
     * Importes ORIGINALES de la factura rectificada. Solo se emite el
     * bloque `<ImporteRectificacion>` cuando `correctionMethod='S'` y
     * estos importes vienen presentes. `recargo` (recargo de
     * equivalencia) es opcional; default 0.
     */
    originalAmounts?: {
      baseRectificada: number;
      cuotaRectificada: number;
      recargo?: number;
    };
    subtotal: number;
    /** Porcentaje (ej. 21, 10, 4, 0). */
    taxRate: number;
    taxAmount: number;
    total: number;
    /** SHA-256 hex (64 chars). Sera serializado en MAYUSCULAS. */
    hash: string;
    /** Hash de la factura inmediatamente anterior de la misma serie; `null`
     *  si es la primera (entonces el XML emite `<PrimerRegistro>S</PrimerRegistro>`). */
    previousHash: string | null;
    previousInvoiceNumber?: string;
    previousInvoiceDate?: Date;
    /** NIF del emisor de la factura anterior. Para tenants normales coincide
     *  con `tenant.taxId`. Lo dejamos parametrizable por si en el futuro se
     *  permiten facturas por terceros. */
    previousEmitterNif?: string;
  };
  /**
   * Destinatario de la factura. Obligatorio para F1 y R1-R5; opcional en
   * F2 (factura simplificada sin destinatario identificado). Cuando se
   * omite y el tipo es F2, el XML emite el flag
   * `<FacturaSinIdentifDestinatarioArt61d>S</...>` y omite el bloque
   * `<Destinatarios>`.
   */
  recipient?: {
    taxId: string;
    name: string;
  };
}

// --------------------------------------------------------------------------
// Helpers internos
// --------------------------------------------------------------------------

/**
 * Devuelve la fecha en formato espanol `DD-MM-YYYY` que exige AEAT en el
 * registro Veri*Factu. Usa los componentes UTC para evitar saltos por
 * timezone del host (la fecha de expedicion es un campo de fecha pura,
 * sin hora).
 */
export function formatSpanishDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  return `${day}-${month}-${year}`;
}

/**
 * Devuelve un timestamp ISO 8601 con el offset explicito de Europe/Madrid
 * (`+01:00` en invierno, `+02:00` en verano). AEAT exige el huso horario en
 * el campo `FechaHoraHusoGenRegistro`.
 *
 * Se calcula el offset comparando la hora local de Madrid contra UTC con
 * `Intl.DateTimeFormat` para evitar depender de la timezone del host.
 */
export function formatTimestampWithMadridTimezone(d: Date): string {
  const tz = 'Europe/Madrid';
  // Partes de la fecha en zona Madrid.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    lookup[p.type] = p.value;
  }
  const year = lookup.year ?? '1970';
  const month = lookup.month ?? '01';
  const day = lookup.day ?? '01';
  // `en-GB` con hour12=false a veces devuelve `24` para medianoche; lo
  // normalizamos a `00` (la fecha ya estara en el dia correcto).
  const rawHour = lookup.hour ?? '00';
  const hour = rawHour === '24' ? '00' : rawHour;
  const minute = lookup.minute ?? '00';
  const second = lookup.second ?? '00';

  // Calculo del offset en minutos comparando "hora Madrid" (interpretada
  // como si fuese UTC) contra el timestamp real.
  const asUtcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offsetMinutes = Math.round((asUtcMs - d.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMinutes);
  const offsetHH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const offsetMM = String(absMin % 60).padStart(2, '0');

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHH}:${offsetMM}`;
}

/**
 * Escapa los cinco caracteres con significado especial en XML.
 *
 * Se aplica a TODOS los strings inyectados en el XML, sin excepcion. Es la
 * unica defensa contra XML injection en este builder (no usamos un DOM
 * builder real para mantener el output predecible y testeable byte a byte).
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
