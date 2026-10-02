import { altaHashInput, computeAltaHash } from '../verifactu-hash';

/** Ejemplos de la especificación de la AEAT (huella de registros de alta). */
describe('Huella Veri*Factu (registro de alta)', () => {
  const first = {
    emitterTaxId: '89890001K',
    invoiceNumber: '12345678/G33',
    issueDate: '01-01-2024',
    invoiceType: 'F1',
    cuotaTotal: 12.35,
    importeTotal: 123.45,
    previousHash: null,
    recordTimestamp: '2024-01-01T19:20:30+01:00',
  };

  it('primer registro: Huella vacía', () => {
    expect(altaHashInput(first)).toBe(
      'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00',
    );
    expect(computeAltaHash(first)).toBe(
      '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60',
    );
  });

  it('registro encadenado con la huella del anterior', () => {
    expect(
      computeAltaHash({
        ...first,
        invoiceNumber: '12345679/G34',
        previousHash: '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60',
        recordTimestamp: '2024-01-01T19:20:35+01:00',
      }),
    ).toBe('F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97');
  });

  it('importes con dos decimales y huella anterior en mayúsculas', () => {
    expect(
      altaHashInput({ ...first, cuotaTotal: 21, importeTotal: -121, previousHash: 'abc' }),
    ).toContain('CuotaTotal=21.00&ImporteTotal=-121.00&Huella=ABC&');
  });
});
