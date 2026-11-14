import { buildAnnexText } from '../annex-text';

describe('buildAnnexText', () => {
  const base = {
    number: 2,
    title: 'Cancelación si no abre',
    body: 'Si el local no abre el 1 de marzo, el inquilino puede cancelar sin coste.',
    contractNumber: 'CT-2026-00007',
    customerName: 'Ana Ruiz',
    unitCode: 'A-12',
    facilityName: 'Trasteros Centro',
    date: '13/11/2026',
  };

  it('toma las partes del contrato firmado y cierra con el consentimiento', () => {
    const text = buildAnnexText({
      ...base,
      signedContractText: [
        'Contrato de alquiler de trastero CT-2026-00007',
        'Arrendador: Trasteros García SL · NIF B12345674',
        'Inquilino: Ana Ruiz · DNI 12345678Z',
        'Trastero: A-12 (Mediano, 6 m²) — Trasteros Centro',
        'Cuota mensual: 90,75 €',
        '',
        'Condiciones generales:',
        'Arrendador: Trasteros García SL · Inquilino: Ana Ruiz · Contrato CT-2026-00007',
      ].join('\n'),
    });
    expect(text.split('\n').slice(0, 6)).toEqual([
      'Anexo 2 al contrato de alquiler CT-2026-00007',
      'Asunto: Cancelación si no abre',
      'Fecha: 13/11/2026',
      'Arrendador: Trasteros García SL · NIF B12345674',
      'Inquilino: Ana Ruiz · DNI 12345678Z',
      'Trastero: A-12 (Mediano, 6 m²) — Trasteros Centro',
    ]);
    expect(text).not.toContain('Cuota mensual');
    // El pie del contrato no se repite.
    expect(text).not.toContain('Contrato CT-2026-00007\n');
    expect(text.match(/Arrendador:/g)).toHaveLength(1);
    expect(text).toContain('Si el local no abre el 1 de marzo');
    expect(text).toContain('En todo lo demás, el contrato sigue igual.');
    expect(text).toContain('art. 25 Reglamento eIDAS');
  });

  it('sin texto firmado, pone el inquilino y el trastero de la ficha', () => {
    const text = buildAnnexText({ ...base, signedContractText: null });
    expect(text).toContain('Inquilino: Ana Ruiz');
    expect(text).toContain('Trastero: A-12 — Trasteros Centro');
  });
});
