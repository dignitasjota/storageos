import { tenantBookingUrl, tenantPortalLoginUrl } from '../portal-url';

const platform = { slug: 'garcia', customDomain: null, customDomainVerifiedAt: null };
const own = {
  slug: 'garcia',
  customDomain: 'trasterosgarcia.es',
  customDomainVerifiedAt: new Date('2026-01-01'),
};

describe('tenantBookingUrl', () => {
  it('en la plataforma, /book/<slug> con el local y el tamaño elegidos', () => {
    expect(
      tenantBookingUrl('https://trasteros.pro', platform, { facilityId: 'f1', unitTypeId: 't1' }),
    ).toBe('https://trasteros.pro/book/garcia?facilityId=f1&unitTypeId=t1');
  });

  it('con dominio propio verificado, /reservar en su dominio', () => {
    expect(tenantBookingUrl('https://trasteros.pro', own, { facilityId: 'f1' })).toBe(
      'https://trasterosgarcia.es/reservar?facilityId=f1',
    );
  });

  it('un dominio sin verificar no se usa; sin nada elegido, sin parámetros', () => {
    expect(
      tenantBookingUrl('https://trasteros.pro', { ...own, customDomainVerifiedAt: null }),
    ).toBe('https://trasteros.pro/book/garcia');
  });
});

describe('tenantPortalLoginUrl', () => {
  it('dominio propio o la plataforma con el slug', () => {
    expect(tenantPortalLoginUrl('https://trasteros.pro', own)).toBe(
      'https://trasterosgarcia.es/portal/login',
    );
    expect(tenantPortalLoginUrl('https://trasteros.pro', platform)).toBe(
      'https://trasteros.pro/portal/login?slug=garcia',
    );
  });
});
