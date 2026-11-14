import { renderContractHtml } from '../contract-pdf-template';
import {
  PREPAID_EARLY_END_LINE,
  accessHoursText,
  buildContractTermsText,
  termsHash,
} from '../contract-terms';

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
      specificConditions: 'Si el local no abre el 1 de marzo, se puede cancelar sin coste.',
    });
    expect(text).toContain(
      'Arrendador: Trasteros García SL · NIF B12345674 · Calle Mayor 1, 28001 Madrid',
    );
    // Las condiciones de este contrato, tras las generales y antes del consentimiento.
    const specific = text.indexOf(
      'Condiciones específicas de este contrato:\nSi el local no abre el 1 de marzo',
    );
    expect(specific).toBeGreaterThan(text.indexOf('Cláusula general'));
    expect(specific).toBeLessThan(text.indexOf('El firmante declara'));
    expect(buildContractTermsText(base)).not.toContain('Condiciones específicas');
    expect(text).toContain('Inquilino: Ana Ruiz · DNI 12345678Z');
    expect(text).toContain('Trastero: A-12 (Mediano, 6 m²) — Trasteros Centro');
    expect(text).toContain('Inicio y entrega del trastero: 01/02/2026');
    expect(text).toContain('se renueva en cada periodo');
    expect(text).toContain('Preaviso de baja: 15 días');
    // Con el IVA incluido, que es lo que paga un consumidor.
    expect(text).toContain('Cuota mensual: 90,75 € IVA incluido (75,00 € + IVA del 21 %)');
    expect(text).toContain('Descuento: −6,05 € al mes, IVA incluido (Fidelidad)');
    expect(text).toContain('Primer pago: 3 meses por adelantado');
    // Lo que pasa si se va antes de usar lo pagado por adelantado.
    expect(text).toContain(PREPAID_EARLY_END_LINE);
    expect(buildContractTermsText(base)).not.toContain(PREPAID_EARLY_END_LINE);
    expect(text).toContain('Cupón BIENVENIDA: −24,20 € en el primer pago, IVA incluido');
    expect(text).toContain(
      'Protección de contenido: Básico — 5,45 € al mes, IVA incluido (4,50 € + IVA del 21 %)',
    );
    // (75 − 5) × 1,21 + 4,50 × 1,21 = 84,70 + 5,45
    expect(text).toContain('Total al mes: 90,15 € IVA incluido');
    expect(text).toContain('Fianza: 150,00 € (sin IVA)');
    expect(text).toContain('Condiciones generales:');
    expect(text).toContain('eIDAS');
  });

  it('la ficha recoge contactos, baja a final de mes, plazo de la fianza, horario y recargos', () => {
    const text = buildContractTermsText({
      ...base,
      landlord: { name: 'Trasteros García SL', taxId: 'B12345674' },
      landlordContact: 'hola@garcia.es · 960 000 000',
      customer: { documentLabel: 'DNI', documentNumber: '12345678Z', email: 'ana@ruiz.es' },
      cancellationNoticeDays: 15,
      moveOutEndOfMonth: true,
      depositReturnDays: 15,
      accessHours: 'de 06:00 a 23:00, todos los días',
      lateFee: { type: 'percentage', value: 5, graceDays: 7 },
      returnedPaymentFee: 4,
      vatRate: 21,
    });
    expect(text).toContain('Contacto para este contrato: hola@garcia.es · 960 000 000');
    expect(text).toContain('Inquilino: Ana Ruiz · DNI 12345678Z · ana@ruiz.es');
    expect(text).toContain('Preaviso de baja: 15 días; la baja surte efecto a final de mes');
    expect(text).toContain(
      'Fianza: 150,00 € (sin IVA); se devuelve en un plazo máximo de 15 días desde la entrega del trastero',
    );
    expect(text).toContain('Horario de acceso: de 06:00 a 23:00, todos los días');
    expect(text).toContain(
      'Recargo por demora: 5 % de lo pendiente de la factura vencida, pasados 7 días de su vencimiento (sin IVA)',
    );
    expect(text).toContain(
      'Gastos por recibo devuelto o pago rechazado: 4,00 € cada uno (sin IVA)',
    );

    const none = buildContractTermsText({ ...base, lateFee: null, returnedPaymentFee: null });
    expect(none).toContain('Recargos por impago: ninguno');
  });

  it('el horario de acceso sale del toque de queda del local', () => {
    expect(accessHoursText({ enabled: true, start: '23:00', end: '06:00' })).toBe(
      'de 06:00 a 23:00, todos los días',
    );
    expect(accessHoursText({ enabled: true, start: '14:00', end: '16:00' })).toBe(
      'todos los días, salvo de 14:00 a 16:00',
    );
    expect(accessHoursText({ enabled: false, start: '23:00', end: '06:00' })).toBe(
      'el publicado para el local',
    );
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

  it('lleva el modelo de formulario de desistimiento cuando aplica', () => {
    const text = buildContractTermsText({
      ...base,
      withdrawalFormTo: 'Trasteros García SL, Calle Mayor 1, 46001 Valencia, hola@garcia.es',
    });
    expect(text).toContain('Modelo de formulario de desistimiento');
    expect(text).toContain(
      'A la atención de Trasteros García SL, Calle Mayor 1, 46001 Valencia, hola@garcia.es:',
    );
    expect(text).toContain(
      `alquiler del trastero ${base.unitCode} (contrato ${base.contractNumber})`,
    );
    expect(buildContractTermsText(base)).not.toContain('Modelo de formulario de desistimiento');
  });

  it('reserva antes de la apertura: la garantía en meses, sin la fecha límite', () => {
    const preOpening = { openingDate: null, maxMonths: 6, unitTypeName: 'Mediano' };
    const text = buildContractTermsText({ ...base, startDate: '2027-05-12', preOpening });
    expect(text).toContain('el día de apertura del local (fecha aún por confirmar)');
    expect(text).toContain('Si pasados 6 meses desde la reserva el local aún no ha abierto');
    expect(text).not.toContain('12/05/2027');
    expect(
      buildContractTermsText({ ...base, preOpening: { ...preOpening, maxMonths: 1 } }),
    ).toContain('Si pasado un mes desde la reserva');
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

  it('deja constancia del plazo para desistir y de la petición de empezar ya', () => {
    const html = renderContractHtml({
      ...input,
      withdrawal: {
        deadline: '2026-02-14',
        immediateStartRequestedAt: new Date('2026-01-31T17:04:00Z'),
      },
    });
    expect(html).toContain('puede desistir sin dar explicaciones hasta el 14/02/2026');
    expect(html).toContain('pidió expresamente empezar a usar el trastero');
    expect(html).toContain('31/01/2026, 18:04');
    const without = renderContractHtml({
      ...input,
      withdrawal: { deadline: '2026-02-14', immediateStartRequestedAt: null },
    });
    expect(without).toContain('hasta el 14/02/2026');
    expect(without).not.toContain('pidió expresamente');
    expect(renderContractHtml(input)).not.toContain('Desistimiento');
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
