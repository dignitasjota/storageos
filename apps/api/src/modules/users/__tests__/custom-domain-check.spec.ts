import { pointsToPlatform } from '../custom-domain-check.service';

describe('pointsToPlatform', () => {
  const platform = { addresses: ['203.0.113.10'], cname: null };

  it('apunta si comparte una IPv4 con la plataforma', () => {
    expect(
      pointsToPlatform({ addresses: ['203.0.113.10'], cname: null }, 'trasteros.pro', platform),
    ).toBe(true);
  });

  it('apunta si su CNAME es el dominio de la plataforma', () => {
    expect(
      pointsToPlatform({ addresses: [], cname: 'Trasteros.pro.' }, 'trasteros.pro', platform),
    ).toBe(true);
  });

  it('no apunta con otra IP o sin registros', () => {
    expect(
      pointsToPlatform({ addresses: ['198.51.100.1'], cname: null }, 'trasteros.pro', platform),
    ).toBe(false);
    expect(pointsToPlatform({ addresses: [], cname: null }, 'trasteros.pro', platform)).toBe(false);
  });
});
