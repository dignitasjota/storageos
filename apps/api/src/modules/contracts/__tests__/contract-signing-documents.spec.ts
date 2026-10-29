import { renderContractHtml } from '../contract-pdf-template';
import { buildContractTermsText, termsHash } from '../contract-terms';

const base = {
  contractNumber: 'C-2026-0001',
  customerName: 'Ana Ruiz',
  unitCode: 'A-12',
  facilityName: 'Trasteros Centro',
  priceMonthly: 75,
  depositAmount: 150,
  billingCycle: 'monthly',
  startDate: '2026-02-01',
};

describe('texto del contrato que se firma', () => {
  it('identifica a las partes y recoge las condiciones económicas', () => {
    const text = buildContractTermsText({
      ...base,
      landlord: {
        name: 'Trasteros García SL',
        taxId: 'B12345674',
        address: 'Calle Mayor 1, 28001 Madrid',
      },
      customer: { documentLabel: 'DNI', documentNumber: '12345678Z', address: null },
      unitDescription: 'Mediano, 6 m²',
      autoRenew: true,
      cancellationNoticeDays: 15,
      vatRate: 21,
      discountAmount: 5,
      discountReason: 'Fidelidad',
      coupon: { code: 'BIENVENIDA', discountAmount: 20, freeMonths: 0, months: 3 },
      firstPaymentMonths: 3,
      insurance: { name: 'Básico', price: 4.5, taxRate: 21 },
      customClauses: 'Cláusula general',
      defaultClauses: true,
    });
    expect(text).toContain(
      'Arrendador: Trasteros García SL · NIF B12345674 · Calle Mayor 1, 28001 Madrid',
    );
    expect(text).toContain('Inquilino: Ana Ruiz · DNI 12345678Z');
    expect(text).toContain('Trastero: A-12 (Mediano, 6 m²) — Trasteros Centro');
    expect(text).toContain('Inicio: 01/02/2026');
    expect(text).toContain('se renueva en cada periodo');
    expect(text).toContain('Preaviso de baja: 15 días');
    expect(text).toContain('Cuota mensual: 75,00 € + IVA (21 %)');
    expect(text).toContain('Descuento: −5,00 € al mes (Fidelidad)');
    expect(text).toContain('Primer pago: 3 meses por adelantado');
    expect(text).toContain('Cupón BIENVENIDA: −20,00 € en el primer pago');
    expect(text).toContain('Protección de contenido: Básico — 4,50 € al mes');
    expect(text).toContain('Fianza: 150,00 € (sin IVA)');
    expect(text).toContain('Condiciones generales:');
    expect(text).toContain('eIDAS');
  });

  it('vivienda: exenta de IVA y con su título; propietario gestionado por el negocio', () => {
    const text = buildContractTermsText({
      ...base,
      propertyKind: 'housing',
      vatRate: 0,
      landlord: { name: 'Propietario SL', taxId: 'B11111111' },
      managedBy: 'Gestiones Norte SL',
      customClauses: 'Cláusulas LAU',
    });
    expect(text).toContain('Contrato de arrendamiento de vivienda C-2026-0001');
    expect(text).toContain('(exenta de IVA)');
    expect(text).toContain('Gestionado por: Gestiones Norte SL');
    expect(text).toContain('Condiciones particulares:');
  });

  it('es determinista: el mismo contrato da la misma huella', () => {
    expect(termsHash(buildContractTermsText(base))).toBe(termsHash(buildContractTermsText(base)));
    expect(termsHash(buildContractTermsText(base))).not.toBe(
      termsHash(buildContractTermsText({ ...base, priceMonthly: 76 })),
    );
  });
});

describe('PDF del contrato', () => {
  const terms = buildContractTermsText(base);
  const signature = {
    signerName: 'Ana Ruiz',
    signerEmail: 'ana@example.com',
    method: 'drawn',
    signatureImage: 'data:image/png;base64,iVBORw0KGgo=',
    typedSignature: null,
    documentHash: termsHash(terms),
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    channel: 'remote',
    signedAt: new Date('2026-01-31T17:04:00Z'),
  };
  const input = {
    contractNumber: 'C-2026-0001',
    housing: false,
    status: 'active',
    termsText: terms,
    termsFrozen: true,
    signedAt: signature.signedAt,
    signatures: [signature],
    tenantName: 'Trasteros García SL',
    generatedAt: new Date('2026-02-01T10:00:00Z'),
  };

  it('lleva el texto firmado, la firma y su evidencia', () => {
    const html = renderContractHtml(input);
    expect(html).toContain('Contrato de alquiler de trastero');
    expect(html).toContain('Cuota mensual: 75,00 €');
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('Enlace enviado al inquilino');
    expect(html).toContain(signature.documentHash);
    expect(html).toContain('31/01/2026, 18:04');
    expect(html).toContain('La huella coincide');
  });

  it('avisa si la huella no coincide y no incrusta imágenes que no sean PNG/JPEG', () => {
    const html = renderContractHtml({
      ...input,
      signatures: [
        {
          ...signature,
          documentHash: 'a'.repeat(64),
          signatureImage: 'javascript:alert(1)',
          signerName: '<b>Ana</b>',
        },
      ],
    });
    expect(html).toContain('La huella no coincide');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });

  it('dice qué versión de las condiciones generales se aceptó', () => {
    const html = renderContractHtml({
      ...input,
      generalTerms: [
        {
          title: 'Condiciones Generales de Contratación',
          version: 3,
          contentHash: 'a'.repeat(64),
          acceptedAt: new Date('2026-10-29T10:00:00Z'),
          channel: 'remote',
        },
      ],
    });
    expect(html).toContain('Condiciones generales de contratación');
    expect(html).toContain('versión 3');
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('en la web, antes de pagar');
    expect(renderContractHtml(input)).not.toContain('Condiciones generales de contratación</h2>');
  });

  it('borrador y contrato sin firma electrónica lo dicen', () => {
    expect(renderContractHtml({ ...input, status: 'draft', signatures: [] })).toContain(
      'Borrador pendiente de firma',
    );
    expect(renderContractHtml({ ...input, signatures: [] })).toContain(
      'sin firma electrónica en TrasterOS',
    );
  });
});
