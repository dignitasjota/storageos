import { platformEndToEndId } from '../platform-sepa-remittance.service';

describe('platformEndToEndId', () => {
  const period = new Date('2026-10-31T00:00:00Z');

  it('primer adeudo: prefijo, slug y fecha', () => {
    expect(platformEndToEndId('garcia', period, 0)).toBe('E2E-SAAS-garcia-2026-10-31');
  });

  it('un slug largo se recorta sin perder la fecha', () => {
    const id = platformEndToEndId('trasteros-garcia', period, 0);
    expect(id).toBe('E2E-SAAS-trasteros-garci-2026-10-31');
    expect(id.length).toBe(35);
  });

  it('reintento tras una devolución: sufijo -R<n> sin pasar de 35 caracteres', () => {
    const id = platformEndToEndId('una-empresa-con-un-slug-muy-largo', period, 2);
    expect(id.length).toBeLessThanOrEqual(35);
    expect(id.endsWith('-2026-10-31-R2')).toBe(true);
    expect(id).not.toBe(platformEndToEndId('una-empresa-con-un-slug-muy-largo', period, 1));
  });

  it('quita los caracteres que SEPA no admite', () => {
    expect(platformEndToEndId('garcía_y_hijos', period, 0)).toBe('E2E-SAAS-garcayhijos-2026-10-31');
  });
});
