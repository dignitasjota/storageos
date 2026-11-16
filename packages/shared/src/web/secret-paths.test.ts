import { describe, expect, it } from 'vitest';

import { redactSecretPaths } from './secret-paths';
import { normalizeWebPath } from './web-analytics';

describe('enlaces secretos fuera de la analítica', () => {
  it('quita el enlace de firma, del anexo y de las cuentas', () => {
    expect(redactSecretPaths('https://garcia.es/sign/abc.def-123?x=1')).toBe(
      'https://garcia.es/sign/enlace?x=1',
    );
    expect(redactSecretPaths('/sign/annex/tok123')).toBe('/sign/annex/enlace');
    expect(redactSecretPaths('/l/en/sign/tok')).toBe('/l/en/sign/enlace');
    expect(redactSecretPaths('/reset-password/a.b')).toBe('/reset-password/enlace');
    expect(redactSecretPaths('/verify-email/change/xyz')).toBe('/verify-email/change/enlace');
    expect(redactSecretPaths('/portal/consume?token=abc.def&x=1')).toBe(
      '/portal/consume?token=enlace&x=1',
    );
  });
  it('no toca el resto de páginas', () => {
    expect(redactSecretPaths('/s/garcia/local-norte')).toBe('/s/garcia/local-norte');
    expect(redactSecretPaths('/reservar?utm_source=google')).toBe('/reservar?utm_source=google');
    expect(redactSecretPaths('/blog/signos-de-humedad')).toBe('/blog/signos-de-humedad');
  });
  it('la analítica propia tampoco guarda el enlace', () => {
    expect(normalizeWebPath('/sign/abc123', 'garcia')).toBe('/sign/enlace');
  });
});
