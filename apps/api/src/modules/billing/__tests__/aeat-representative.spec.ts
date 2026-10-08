import {
  nameFromCommonName,
  nifFromCertValue,
  resolveRepresentative,
} from '../aeat-client/representative';

const cred = (over: Partial<Parameters<typeof resolveRepresentative>[1]> = {}) => ({
  certNif: 'B12345674',
  certOrganizationNif: null,
  certCommonName: 'TRASTEROS DEMO SL',
  representativeName: null,
  ...over,
});

describe('representante en Veri*Factu', () => {
  it('certificado del propio tenant: sin representante', () => {
    expect(resolveRepresentative('ES-B12345674', cred())).toBeNull();
    // Certificado de representante de su propia empresa: la entidad es el tenant.
    expect(
      resolveRepresentative(
        'B12345674',
        cred({ certNif: '12345678Z', certOrganizationNif: 'B12345674' }),
      ),
    ).toBeNull();
  });

  it('certificado de otra persona: el titular es el representante', () => {
    expect(
      resolveRepresentative(
        'B12345674',
        cred({ certNif: '12345678Z', certCommonName: 'PEREZ GOMEZ JUAN - NIF 12345678Z' }),
      ),
    ).toEqual({ taxId: '12345678Z', name: 'PEREZ GOMEZ JUAN' });
  });

  it('certificado de una gestoría: representa la entidad, con el nombre elegido', () => {
    expect(
      resolveRepresentative(
        'B12345674',
        cred({
          certNif: '12345678Z',
          certOrganizationNif: 'B87654321',
          certCommonName: '12345678Z JUAN PEREZ (R: B87654321)',
          representativeName: 'Gestoría Ejemplo SL',
        }),
      ),
    ).toEqual({ taxId: 'B87654321', name: 'Gestoría Ejemplo SL' });
  });

  it('sin NIF del tenant no se decide nada', () => {
    expect(resolveRepresentative(null, cred({ certNif: '12345678Z' }))).toBeNull();
  });

  it('lee NIF y nombre de los valores del certificado', () => {
    expect(nifFromCertValue('VATES-B87654321')).toBe('B87654321');
    expect(nifFromCertValue('IDCES-12345678Z')).toBe('12345678Z');
    expect(nifFromCertValue(null)).toBeNull();
    expect(nameFromCommonName('12345678Z JUAN PEREZ (R: B87654321)')).toBe('JUAN PEREZ');
  });
});
