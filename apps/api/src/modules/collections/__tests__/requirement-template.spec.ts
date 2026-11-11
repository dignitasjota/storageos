import { renderRequirementHtml, type RequirementData } from '../requirement-template';

function baseData(overrides: Partial<RequirementData> = {}): RequirementData {
  return {
    issuer: {
      name: 'Trasteros García SL',
      taxId: 'B12345674',
      address: 'Calle Fiscal 3, 28001 Madrid',
      managedBy: null,
    },
    noticeDays: 15,
    clauseRef: 'Cláusula 12 del contrato',
    customer: {
      customerType: 'individual',
      firstName: 'Juan',
      lastName: 'Pérez',
      companyName: null,
      documentType: 'dni',
      documentNumber: '12345678Z',
      address: 'Calle Mayor 1',
      city: 'Madrid',
      postalCode: '28001',
    },
    unitCode: 'A-12',
    contractNumber: 'C-2026-001',
    facility: {
      name: 'Local Centro',
      address: 'Av. del Local 5',
      city: 'Madrid',
      postalCode: '28002',
      contactPhone: '910000000',
      contactEmail: 'centro@trasteros.pro',
    },
    lines: [
      {
        number: 'F-001',
        issueDate: '2026-05-01',
        dueDate: '2026-05-16',
        totalCents: 12100,
        pendingCents: 12100,
      },
      {
        number: 'F-002',
        issueDate: '2026-06-01',
        dueDate: '2026-06-16',
        totalCents: 12100,
        pendingCents: 6000,
      },
    ],
    debtCents: 18100,
    payment: { iban: 'ES9121000418450200051332', portalUrl: 'https://garcia.es/portal/login' },
    today: '22 de julio de 2026',
    ...overrides,
  };
}

describe('renderRequirementHtml', () => {
  it('incluye arrendador, inquilino, trastero, facturas, deuda y plazo', () => {
    const html = renderRequirementHtml(baseData());
    expect(html).toContain('Trasteros García SL');
    expect(html).toContain('NIF: B12345674');
    expect(html).toContain('Calle Fiscal 3, 28001 Madrid');
    expect(html).toContain('Juan Pérez');
    expect(html).toContain('DNI 12345678Z');
    expect(html).toContain('A-12');
    expect(html).toContain('C-2026-001');
    expect(html).toContain('Requerimiento fehaciente de pago');
    // Vencimiento de cada factura en formato español.
    expect(html).toContain('16/05/2026');
    // Plazo desde la recepción y total adeudado (18100 céntimos → 181,00 €).
    expect(html).toContain('15 días\n    naturales desde que lo reciba');
    expect(html).toContain('181,00');
    expect(html).toContain('Cláusula 12 del contrato');
  });

  it('dice lo que pasa si no paga (condición 12) sin amenazar con vender', () => {
    const html = renderRequirementHtml(baseData());
    expect(html).toContain('contrato quedará resuelto');
    expect(html).toContain('retirar sus bienes');
    expect(html).toContain('trasladarán con inventario');
    expect(html).toContain('cauces legales');
    expect(html).not.toMatch(/subasta|venta del contenido|resarcirse/i);
  });

  it('da los medios de pago que tiene el negocio', () => {
    const html = renderRequirementHtml(baseData());
    expect(html).toContain('ES9121000418450200051332');
    expect(html).toContain('https://garcia.es/portal/login');
    expect(html).toContain('o en el propio local');
    const sinIban = renderRequirementHtml(baseData({ payment: { iban: null, portalUrl: null } }));
    expect(sinIban).not.toContain('transferencia');
    expect(sinIban).toContain('o en el propio local');
  });

  it('con propietario, el arrendador es él y dice quién gestiona', () => {
    const html = renderRequirementHtml(
      baseData({
        issuer: {
          name: 'Inversiones Pérez SL',
          taxId: 'B87654321',
          address: null,
          managedBy: 'Trasteros García',
        },
      }),
    );
    expect(html).toContain('Inversiones Pérez SL');
    expect(html).toContain('Gestionado por Trasteros García');
  });

  it('usa la razón social para clientes empresa y escapa el HTML', () => {
    const html = renderRequirementHtml(
      baseData({
        customer: {
          customerType: 'business',
          firstName: null,
          lastName: null,
          companyName: 'Bodegas <S.L.> & Cía',
          documentType: 'cif',
          documentNumber: 'B99',
          address: 'Calle 1',
          city: 'Madrid',
          postalCode: null,
        },
      }),
    );
    expect(html).toContain('Bodegas &lt;S.L.&gt; &amp; Cía');
    expect(html).not.toContain('<S.L.>');
  });

  it('sin facturas vencidas muestra el aviso y no rompe', () => {
    const html = renderRequirementHtml(baseData({ lines: [], debtCents: 0 }));
    expect(html).toContain('Sin facturas vencidas');
    expect(html).toContain('0,00');
  });

  it('sin cláusula propia cita la condición 12 de las condiciones del contrato', () => {
    const html = renderRequirementHtml(baseData({ clauseRef: null, noticeDays: 20 }));
    expect(html).toContain('20 días');
    expect(html).toContain('condición 12 de las condiciones del contrato');
  });
});
