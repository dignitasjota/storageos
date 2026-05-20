import { ConfigService } from '@nestjs/config';

import {
  VerifactuXmlBuilder,
  escapeXml,
  formatSpanishDate,
  formatTimestampWithMadridTimezone,
  type BuildRegistroAltaArgs,
} from '../src/modules/billing/aeat-client/verifactu-xml-builder';

import type { Env } from '../src/config/env.schema';

/**
 * Construye un `ConfigService` mock con los valores de sistema informatico
 * por defecto (placeholders dev). Cualquier override se pasa por `overrides`.
 */
function createConfig(
  overrides: Partial<Record<keyof Env, string>> = {},
): ConfigService<Env, true> {
  const values: Record<string, string> = {
    AEAT_SISTEMA_NIF: 'B00000000',
    AEAT_SISTEMA_NOMBRE: 'StorageOS',
    AEAT_SISTEMA_VERSION: '1.0.0',
    AEAT_SISTEMA_INSTALACION: '001',
    ...(overrides as Record<string, string>),
  };
  return {
    get: (key: string) => {
      if (key in values) return values[key];
      throw new Error(`Unexpected config key in test: ${key}`);
    },
  } as unknown as ConfigService<Env, true>;
}

/**
 * Args base: primera factura de la serie F, IVA 21%, cliente con NIF
 * espanol. Cada test puede override parcialmente con `withInvoice` /
 * `withRecipient`.
 */
function baseArgs(): BuildRegistroAltaArgs {
  return {
    tenant: {
      name: 'Trasteros Demo SL',
      taxId: 'B12345678',
    },
    invoice: {
      series: 'F',
      invoiceNumber: 'F-2026-0001',
      issueDate: new Date('2026-05-20T00:00:00.000Z'),
      description: 'Alquiler trastero T-12 mes mayo 2026',
      invoiceType: 'F1',
      subtotal: 100.0,
      taxRate: 21.0,
      taxAmount: 21.0,
      total: 121.0,
      hash: 'A'.repeat(64),
      previousHash: null,
    },
    recipient: {
      taxId: '12345678Z',
      name: 'Juan Perez Garcia',
    },
  };
}

/**
 * Verifica que el XML esta bien formado (well-formed) sin depender de un
 * parser externo. Comprueba:
 *  - Cabecera `<?xml ... ?>`.
 *  - Cada tag se abre antes de cerrarse (stack balanceado).
 *  - El stack queda vacio al final.
 *
 * No verifica conformidad con XSD (eso lo hara la AEAT) ni resuelve
 * entidades, pero es suficiente para detectar errores groseros como tags
 * cruzados o sin cerrar.
 */
function assertWellFormedXml(xml: string): void {
  expect(xml.startsWith('<?xml ')).toBe(true);

  // Strip declaracion XML y comentarios para simplificar el parser.
  const body = xml.replace(/^<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');

  // Captura tags: <name ...>, </name>, <name .../> (self-closed).
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null = tagRe.exec(body);
  while (match !== null) {
    const full = match[0];
    const name = match[1] ?? '';
    const selfClose = match[3] === '/';
    const isClose = full.startsWith('</');
    if (isClose) {
      const last = stack.pop();
      expect(last).toBe(name);
    } else if (!selfClose) {
      stack.push(name);
    }
    match = tagRe.exec(body);
  }
  expect(stack).toEqual([]);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('VerifactuXmlBuilder', () => {
  describe('buildRegistroAlta', () => {
    it('emite un primer registro (cadena vacia) con todos los campos clave', () => {
      const builder = new VerifactuXmlBuilder(createConfig());
      const xml = builder.buildRegistroAlta(baseArgs());

      // Es well-formed.
      assertWellFormedXml(xml);

      // Cabecera SOAP + namespaces.
      expect(xml).toContain('<soapenv:Envelope');
      expect(xml).toContain('xmlns:sum="https://www2.agenciatributaria.gob.es');
      expect(xml).toContain('xmlns:sum1="https://www2.agenciatributaria.gob.es');
      expect(xml).toContain('<sum:RegFactuSistemaFacturacion>');
      expect(xml).toContain('<sum:RegistroAlta>');

      // Obligado emision.
      expect(xml).toContain('<sum1:NombreRazon>Trasteros Demo SL</sum1:NombreRazon>');
      expect(xml).toContain('<sum1:NIF>B12345678</sum1:NIF>');

      // Identificacion factura.
      expect(xml).toContain('<sum1:NumSerieFactura>F-2026-0001</sum1:NumSerieFactura>');
      expect(xml).toContain(
        '<sum1:FechaExpedicionFactura>20-05-2026</sum1:FechaExpedicionFactura>',
      );
      expect(xml).toContain('<sum1:TipoFactura>F1</sum1:TipoFactura>');
      expect(xml).toContain(
        '<sum1:DescripcionOperacion>Alquiler trastero T-12 mes mayo 2026</sum1:DescripcionOperacion>',
      );

      // Destinatario.
      expect(xml).toContain('<sum1:NombreRazon>Juan Perez Garcia</sum1:NombreRazon>');
      expect(xml).toContain('<sum1:NIF>12345678Z</sum1:NIF>');

      // Desglose IVA.
      expect(xml).toContain('<sum1:Impuesto>01</sum1:Impuesto>');
      expect(xml).toContain('<sum1:ClaveRegimen>01</sum1:ClaveRegimen>');
      expect(xml).toContain('<sum1:CalificacionOperacion>S1</sum1:CalificacionOperacion>');
      expect(xml).toContain('<sum1:TipoImpositivo>21.00</sum1:TipoImpositivo>');
      expect(xml).toContain(
        '<sum1:BaseImponibleOimporteNoSujeto>100.00</sum1:BaseImponibleOimporteNoSujeto>',
      );
      expect(xml).toContain('<sum1:CuotaRepercutida>21.00</sum1:CuotaRepercutida>');
      expect(xml).toContain('<sum1:CuotaTotal>21.00</sum1:CuotaTotal>');
      expect(xml).toContain('<sum1:ImporteTotal>121.00</sum1:ImporteTotal>');

      // Primer registro: sin encadenado anterior.
      expect(xml).toContain('<sum1:PrimerRegistro>S</sum1:PrimerRegistro>');
      expect(xml).not.toContain('<sum1:RegistroAnterior>');

      // Sistema informatico.
      expect(xml).toContain(
        '<sum1:NombreSistemaInformatico>StorageOS</sum1:NombreSistemaInformatico>',
      );
      expect(xml).toContain('<sum1:IdSistemaInformatico>01</sum1:IdSistemaInformatico>');
      expect(xml).toContain('<sum1:Version>1.0.0</sum1:Version>');
      expect(xml).toContain('<sum1:NumeroInstalacion>001</sum1:NumeroInstalacion>');
      expect(xml).toContain(
        '<sum1:TipoUsoPosibleSoloVerifactu>S</sum1:TipoUsoPosibleSoloVerifactu>',
      );
      expect(xml).toContain('<sum1:IndicadorMultiplesOT>N</sum1:IndicadorMultiplesOT>');

      // Huella en mayusculas, tipo 01 (SHA-256).
      expect(xml).toContain('<sum1:TipoHuella>01</sum1:TipoHuella>');
      expect(xml).toContain(`<sum1:Huella>${'A'.repeat(64)}</sum1:Huella>`);
    });

    it('encadena con RegistroAnterior cuando hay previousHash', () => {
      const builder = new VerifactuXmlBuilder(createConfig());
      const args = baseArgs();
      args.invoice.previousHash = 'b'.repeat(64);
      args.invoice.previousInvoiceNumber = 'F-2026-0000';
      args.invoice.previousInvoiceDate = new Date('2026-04-30T00:00:00.000Z');
      args.invoice.previousEmitterNif = 'B12345678';

      const xml = builder.buildRegistroAlta(args);
      assertWellFormedXml(xml);

      expect(xml).toContain('<sum1:RegistroAnterior>');
      expect(xml).toContain('<sum1:IDEmisorFactura>B12345678</sum1:IDEmisorFactura>');
      expect(xml).toContain('<sum1:NumSerieFactura>F-2026-0000</sum1:NumSerieFactura>');
      expect(xml).toContain(
        '<sum1:FechaExpedicionFactura>30-04-2026</sum1:FechaExpedicionFactura>',
      );
      // El previousHash se serializa en mayusculas aunque venga en minusculas.
      expect(xml).toContain(`<sum1:Huella>${'B'.repeat(64)}</sum1:Huella>`);
      expect(xml).not.toContain('<sum1:PrimerRegistro>');
    });

    it('escapa caracteres XML peligrosos en nombres y descripciones', () => {
      const builder = new VerifactuXmlBuilder(createConfig());
      const args = baseArgs();
      args.recipient.name = 'Juan & Maria <test>';
      args.invoice.description = 'Comilla " y apostrofe \' en descripcion';
      args.tenant.name = 'Trasteros & Co <SL>';

      const xml = builder.buildRegistroAlta(args);
      assertWellFormedXml(xml);

      // Los caracteres peligrosos NO deben aparecer crudos dentro del XML
      // en posicion de contenido (excepto por las propias declaraciones de
      // namespace, que solo contienen `<`/`>` en el wrapping de tags).
      // Verificamos las versiones escapadas presentes:
      expect(xml).toContain('Juan &amp; Maria &lt;test&gt;');
      expect(xml).toContain('Trasteros &amp; Co &lt;SL&gt;');
      expect(xml).toContain('Comilla &quot; y apostrofe &apos; en descripcion');

      // Y que las versiones crudas NO estan en los campos inyectados.
      expect(xml).not.toContain('Juan & Maria');
      expect(xml).not.toContain('Trasteros & Co');
    });

    it('emite TipoFactura R1 + TipoRectificativa I + FacturasRectificadas para una rectificativa', () => {
      const builder = new VerifactuXmlBuilder(createConfig());
      const args = baseArgs();
      args.invoice.invoiceType = 'R1';
      args.invoice.correctionMethod = 'I';
      args.invoice.rectifies = [
        {
          emitterTaxId: 'B12345678',
          invoiceNumber: 'FA/2026/00001',
          issueDate: new Date('2026-05-10T00:00:00.000Z'),
        },
      ];

      const xml = builder.buildRegistroAlta(args);
      assertWellFormedXml(xml);

      expect(xml).toContain('<sum1:TipoFactura>R1</sum1:TipoFactura>');
      expect(xml).toContain('<sum1:TipoRectificativa>I</sum1:TipoRectificativa>');
      expect(xml).toContain('<sum1:FacturasRectificadas>');
      expect(xml).toContain('<sum1:IDFacturaAnterior>');
      expect(xml).toContain('<sum1:NumSerieFactura>FA/2026/00001</sum1:NumSerieFactura>');
      expect(xml).toContain(
        '<sum1:FechaExpedicionFactura>10-05-2026</sum1:FechaExpedicionFactura>',
      );
      // El TipoRectificativa va ANTES de Desglose en el XML.
      const idxRect = xml.indexOf('<sum1:TipoRectificativa>');
      const idxDesglose = xml.indexOf('<sum1:Desglose>');
      expect(idxRect).toBeGreaterThan(-1);
      expect(idxRect).toBeLessThan(idxDesglose);
    });

    it('emite TipoRectificativa S cuando correctionMethod=S (sustitucion)', () => {
      const builder = new VerifactuXmlBuilder(createConfig());
      const args = baseArgs();
      args.invoice.invoiceType = 'R4';
      args.invoice.correctionMethod = 'S';
      args.invoice.rectifies = [
        {
          emitterTaxId: 'B12345678',
          invoiceNumber: 'FA/2026/00001',
          issueDate: new Date('2026-05-10T00:00:00.000Z'),
        },
      ];

      const xml = builder.buildRegistroAlta(args);
      assertWellFormedXml(xml);
      expect(xml).toContain('<sum1:TipoFactura>R4</sum1:TipoFactura>');
      expect(xml).toContain('<sum1:TipoRectificativa>S</sum1:TipoRectificativa>');
    });

    it('rectificativa sin lista de facturas anteriores omite FacturasRectificadas', () => {
      const builder = new VerifactuXmlBuilder(createConfig());
      const args = baseArgs();
      args.invoice.invoiceType = 'R5';
      args.invoice.correctionMethod = 'I';
      args.invoice.rectifies = [];

      const xml = builder.buildRegistroAlta(args);
      assertWellFormedXml(xml);
      expect(xml).toContain('<sum1:TipoFactura>R5</sum1:TipoFactura>');
      expect(xml).toContain('<sum1:TipoRectificativa>I</sum1:TipoRectificativa>');
      expect(xml).not.toContain('<sum1:FacturasRectificadas>');
    });

    it('respeta el NIF del sistema informatico configurado por env', () => {
      const builder = new VerifactuXmlBuilder(
        createConfig({
          AEAT_SISTEMA_NIF: 'B99999999',
          AEAT_SISTEMA_NOMBRE: 'CustomSaaS',
          AEAT_SISTEMA_VERSION: '2.4.1',
          AEAT_SISTEMA_INSTALACION: '042',
        }),
      );
      const xml = builder.buildRegistroAlta(baseArgs());

      // El bloque SistemaInformatico contiene un <sum1:NIF> propio. Como
      // hay otro <sum1:NIF> (el del cliente), buscamos por contexto.
      expect(xml).toContain(
        '<sum1:NombreSistemaInformatico>CustomSaaS</sum1:NombreSistemaInformatico>',
      );
      expect(xml).toContain('<sum1:Version>2.4.1</sum1:Version>');
      expect(xml).toContain('<sum1:NumeroInstalacion>042</sum1:NumeroInstalacion>');
      // El NIF del sistema aparece dentro de SistemaInformatico (no del
      // emisor). Como verificacion sencilla: el XML contiene B99999999.
      expect(xml).toContain('B99999999');
    });
  });

  describe('helpers', () => {
    describe('formatSpanishDate', () => {
      it('formatea en DD-MM-YYYY usando componentes UTC', () => {
        expect(formatSpanishDate(new Date('2026-05-20T00:00:00.000Z'))).toBe('20-05-2026');
        expect(formatSpanishDate(new Date('2026-01-01T23:59:59.000Z'))).toBe('01-01-2026');
        expect(formatSpanishDate(new Date('2026-12-31T12:00:00.000Z'))).toBe('31-12-2026');
      });
    });

    describe('formatTimestampWithMadridTimezone', () => {
      it('en invierno (CET) emite offset +01:00', () => {
        // 15 enero 2026 12:00 UTC -> 13:00 Madrid +01:00
        const ts = formatTimestampWithMadridTimezone(new Date('2026-01-15T12:00:00.000Z'));
        expect(ts).toBe('2026-01-15T13:00:00+01:00');
      });

      it('en verano (CEST) emite offset +02:00', () => {
        // 15 julio 2026 12:00 UTC -> 14:00 Madrid +02:00
        const ts = formatTimestampWithMadridTimezone(new Date('2026-07-15T12:00:00.000Z'));
        expect(ts).toBe('2026-07-15T14:00:00+02:00');
      });
    });

    describe('escapeXml', () => {
      it('escapa los cinco caracteres especiales', () => {
        expect(escapeXml('a & b')).toBe('a &amp; b');
        expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
        expect(escapeXml('say "hi"')).toBe('say &quot;hi&quot;');
        expect(escapeXml("it's")).toBe('it&apos;s');
      });

      it('escapa el ampersand primero (no doble escape)', () => {
        expect(escapeXml('&amp;')).toBe('&amp;amp;');
      });
    });
  });
});
