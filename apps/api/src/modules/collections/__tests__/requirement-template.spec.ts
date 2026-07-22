import { renderRequirementHtml, type RequirementData } from '../requirement-template';

function baseData(overrides: Partial<RequirementData> = {}): RequirementData {
  return {
    tenant: {
      name: 'Trasteros García',
      taxId: 'B12345678',
      collectionsNoticeDays: 15,
      collectionsClauseRef: 'Cláusula 9ª del contrato',
    },
    customer: {
      customerType: 'individual',
      firstName: 'Juan',
      lastName: 'Pérez',
      companyName: null,
      documentType: 'DNI',
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
      { number: 'F-001', issueDate: '2026-05-01', totalCents: 12100, pendingCents: 12100 },
      { number: 'F-002', issueDate: '2026-06-01', totalCents: 12100, pendingCents: 6000 },
    ],
    debtCents: 18100,
    today: '22 de julio de 2026',
    ...overrides,
  };
}

describe('renderRequirementHtml', () => {
  it('incluye operador, inquilino, trastero, deuda y plazo', () => {
    const html = renderRequirementHtml(baseData());
    expect(html).toContain('Trasteros García');
    expect(html).toContain('Juan Pérez');
    expect(html).toContain('DNI 12345678Z');
    expect(html).toContain('A-12');
    expect(html).toContain('C-2026-001');
    expect(html).toContain('Requerimiento fehaciente de pago');
    // Plazo del tenant y total adeudado (18100 céntimos → 181,00 €).
    expect(html).toContain('15 días naturales');
    expect(html).toContain('181,00');
    // La cláusula del contrato se referencia en la advertencia.
    expect(html).toContain('Cláusula 9ª del contrato');
  });

  it('usa la razón social para clientes empresa y escapa el HTML', () => {
    const html = renderRequirementHtml(
      baseData({
        customer: {
          customerType: 'business',
          firstName: null,
          lastName: null,
          companyName: 'Bodegas <S.L.> & Cía',
          documentType: 'CIF',
          documentNumber: 'B99',
          address: null,
          city: null,
          postalCode: null,
        },
      }),
    );
    expect(html).toContain('Bodegas &lt;S.L.&gt; &amp; Cía');
    expect(html).not.toContain('<S.L.>');
  });

  it('sin facturas pendientes muestra el aviso y no rompe', () => {
    const html = renderRequirementHtml(baseData({ lines: [], debtCents: 0 }));
    expect(html).toContain('Sin facturas pendientes registradas');
    expect(html).toContain('0,00');
  });

  it('sin cláusula de contrato omite la referencia entre paréntesis', () => {
    const html = renderRequirementHtml(
      baseData({
        tenant: {
          name: 'Op',
          taxId: null,
          collectionsNoticeDays: 20,
          collectionsClauseRef: null,
        },
      }),
    );
    expect(html).toContain('20 días naturales');
    expect(html).not.toContain('()');
  });
});
