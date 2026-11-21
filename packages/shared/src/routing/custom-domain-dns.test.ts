import { describe, expect, it } from 'vitest';

import {
  customDomainAlternate,
  customDomainDnsRecords,
  customDomainHosts,
  isApexDomain,
  matchesCustomDomain,
  registrableDomain,
  relativeRecordName,
} from './custom-domain-dns';

const target = { host: 'trasteros.pro', addresses: ['203.0.113.10'] };

describe('registrableDomain / isApexDomain', () => {
  it('reconoce la raíz con sufijos de uno y dos niveles', () => {
    expect(registrableDomain('tienda.garcia.com')).toBe('garcia.com');
    expect(registrableDomain('www.garcia.com.es')).toBe('garcia.com.es');
    expect(isApexDomain('garcia.com')).toBe(true);
    expect(isApexDomain('garcia.com.es')).toBe(true);
    expect(isApexDomain('trasteros.garcia.com')).toBe(false);
  });
});

describe('customDomainAlternate', () => {
  it('añade o quita el www solo en la raíz', () => {
    expect(customDomainAlternate('garcia.com')).toBe('www.garcia.com');
    expect(customDomainAlternate('WWW.Garcia.com')).toBe('garcia.com');
    expect(customDomainAlternate('trasteros.garcia.com')).toBeNull();
    expect(customDomainAlternate('www.trasteros.garcia.com')).toBeNull();
    expect(customDomainHosts('garcia.com')).toEqual(['garcia.com', 'www.garcia.com']);
  });

  it('acepta las dos formas como el mismo dominio', () => {
    expect(matchesCustomDomain('www.garcia.com', 'garcia.com')).toBe(true);
    expect(matchesCustomDomain('garcia.com', 'www.garcia.com')).toBe(true);
    expect(matchesCustomDomain('otro.com', 'garcia.com')).toBe(false);
  });
});

describe('relativeRecordName', () => {
  it('quita el dominio y usa @ para la raíz', () => {
    expect(relativeRecordName('garcia.com', 'garcia.com')).toBe('@');
    expect(relativeRecordName('www.garcia.com', 'garcia.com')).toBe('www');
    expect(relativeRecordName('a.b.garcia.com', 'garcia.com')).toBe('a.b');
  });
});

describe('customDomainDnsRecords', () => {
  it('raíz: A a la IP y www como CNAME al principal', () => {
    expect(customDomainDnsRecords('garcia.com', target)).toEqual([
      { type: 'A', name: '@', host: 'garcia.com', value: '203.0.113.10', purpose: 'primary' },
      {
        type: 'CNAME',
        name: 'www',
        host: 'www.garcia.com',
        value: 'garcia.com',
        purpose: 'alternate',
      },
    ]);
  });

  it('con www como principal: CNAME del www y A en la raíz', () => {
    expect(customDomainDnsRecords('www.garcia.com', target)).toEqual([
      {
        type: 'CNAME',
        name: 'www',
        host: 'www.garcia.com',
        value: 'trasteros.pro',
        purpose: 'primary',
      },
      { type: 'A', name: '@', host: 'garcia.com', value: '203.0.113.10', purpose: 'alternate' },
    ]);
  });

  it('subdominio: un CNAME a la plataforma y sin www', () => {
    expect(customDomainDnsRecords('trasteros.garcia.com', target)).toEqual([
      {
        type: 'CNAME',
        name: 'trasteros',
        host: 'trasteros.garcia.com',
        value: 'trasteros.pro',
        purpose: 'primary',
      },
    ]);
  });

  it('sin IP conocida, la raíz va como ALIAS', () => {
    const records = customDomainDnsRecords('garcia.com', { host: 'trasteros.pro', addresses: [] });
    expect(records[0]).toMatchObject({ type: 'ALIAS', name: '@', value: 'trasteros.pro' });
  });
});
