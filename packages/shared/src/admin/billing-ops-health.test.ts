import { describe, expect, it } from 'vitest';

import {
  aeatErrorGuide,
  buildBillingNotice,
  extractAeatErrorCode,
  BILLING_NOTICE_KINDS,
} from './billing-ops-health';
import { buildDomainGuide, domainCertMilestone, proxyHostNames } from './domains-ops';

describe('guía de errores de la AEAT', () => {
  it('saca el código del mensaje y de la respuesta guardada', () => {
    expect(extractAeatErrorCode('[1100] Valor incorrecto')).toBe('1100');
    expect(extractAeatErrorCode('aeat_fault: caído')).toBe('aeat_fault');
    expect(extractAeatErrorCode('sin código', { code: '4112' })).toBe('4112');
    expect(extractAeatErrorCode(null)).toBeNull();
  });

  it('da una pista por código y, si no, por el texto', () => {
    expect(aeatErrorGuide('3000', null)?.kind).toBe('retry');
    expect(aeatErrorGuide('4112', null)?.kind).toBe('fix');
    expect(aeatErrorGuide(null, 'El NIF del destinatario no está censado')?.kind).toBe('fix');
    expect(aeatErrorGuide(null, 'ETIMEDOUT')?.kind).toBe('retry');
    expect(aeatErrorGuide('9999', 'algo raro')).toBeNull();
  });
});

describe('avisos al tenant', () => {
  it('redacta cada tipo con el nombre y añade el mensaje opcional', () => {
    for (const kind of BILLING_NOTICE_KINDS) {
      const n = buildBillingNotice(
        kind,
        {
          tenantName: 'Trasteros García',
          daysLeft: 5,
          validTo: '01/12/2026',
          count: 2,
          exampleNumber: 'A-1',
          reviewCount: 3,
        },
        'Escríbenos si tienes dudas.',
      );
      expect(n.subject.length).toBeGreaterThan(5);
      expect(n.body).toContain('Trasteros García');
      expect(n.body).toContain('Escríbenos si tienes dudas.');
    }
  });

  it('distingue caducado de a punto de caducar', () => {
    const soon = buildBillingNotice('certificate_expiring', { tenantName: 'X', daysLeft: 5 });
    const past = buildBillingNotice('certificate_expiring', { tenantName: 'X', daysLeft: -2 });
    expect(soon.body).toContain('caduca');
    expect(past.body).toContain('ha caducado');
  });
});

describe('dominios propios', () => {
  it('el hito de aviso del certificado: 14, 7 y 1 días', () => {
    expect(domainCertMilestone(30)).toBeNull();
    expect(domainCertMilestone(14)).toBe(14);
    expect(domainCertMilestone(9)).toBe(14);
    expect(domainCertMilestone(7)).toBe(7);
    expect(domainCertMilestone(3)).toBe(7);
    expect(domainCertMilestone(1)).toBe(1);
    expect(domainCertMilestone(-4)).toBe(1);
  });

  it('el Proxy Host lleva el dominio y su variante con o sin www', () => {
    expect(proxyHostNames('garcia.com')).toEqual(['garcia.com', 'www.garcia.com']);
    expect(proxyHostNames('trasteros.garcia.com')).toEqual(['trasteros.garcia.com']);
  });

  it('la guía da el DNS exacto y los pasos de NPM', () => {
    const g = buildDomainGuide('garcia.com', { host: 'trasteros.pro', addresses: ['1.2.3.4'] });
    expect(g.records.some((r) => r.type === 'A' && r.value === '1.2.3.4')).toBe(true);
    expect(g.records.some((r) => r.type === 'CNAME' && r.value === 'garcia.com')).toBe(true);
    expect(g.dnsText).toContain('1.2.3.4');
    expect(g.npmText).toContain('garcia.com, www.garcia.com');
    expect(g.npmText).toContain('web');
    expect(g.npmText).toContain('3000');
  });
});
