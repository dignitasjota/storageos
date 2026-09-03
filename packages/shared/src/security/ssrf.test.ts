import { describe, expect, it } from 'vitest';

import { isDisallowedIp, isIPv4Literal, parseExternalSiteUrl } from './ssrf';

describe('isIPv4Literal', () => {
  it('reconoce IPv4 válidas', () => {
    expect(isIPv4Literal('1.2.3.4')).toBe(true);
    expect(isIPv4Literal('255.255.255.255')).toBe(true);
    expect(isIPv4Literal('0.0.0.0')).toBe(true);
  });

  it('rechaza lo que no es una IPv4', () => {
    expect(isIPv4Literal('256.1.1.1')).toBe(false);
    expect(isIPv4Literal('example.com')).toBe(false);
    expect(isIPv4Literal('1.2.3')).toBe(false);
    expect(isIPv4Literal('::1')).toBe(false);
  });
});

describe('isDisallowedIp', () => {
  it('rechaza rangos IPv4 privados/loopback/link-local/reservados', () => {
    for (const ip of [
      '127.0.0.1', // loopback
      '10.0.0.5', // privada
      '172.16.0.1', // privada
      '172.31.255.255', // privada (límite superior del /12)
      '192.168.1.1', // privada
      '169.254.1.1', // link-local
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0', // "esta" red
      '224.0.0.1', // multicast
      '255.255.255.255', // broadcast
    ]) {
      expect(isDisallowedIp(ip)).toBe(true);
    }
  });

  it('acepta IPv4 públicas', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isDisallowedIp(ip)).toBe(false);
    }
  });

  it('rechaza rangos IPv6 loopback/privados/link-local', () => {
    expect(isDisallowedIp('::1')).toBe(true);
    expect(isDisallowedIp('::')).toBe(true);
    expect(isDisallowedIp('fe80::1')).toBe(true); // link-local
    expect(isDisallowedIp('fc00::1')).toBe(true); // unique local
    expect(isDisallowedIp('fd12:3456:789a::1')).toBe(true); // unique local
  });

  it('rechaza IPv4 privada mapeada en IPv6', () => {
    expect(isDisallowedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isDisallowedIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('acepta IPv6 pública', () => {
    expect(isDisallowedIp('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    // Misma dirección pública, forma completamente expandida (sin `::`).
    expect(isDisallowedIp('2001:4860:4860:0:0:0:0:8888')).toBe(false); // Google DNS
  });

  it('tolera el hostname entre corchetes (como viene de una URL)', () => {
    expect(isDisallowedIp('[::1]')).toBe(true);
  });

  it(
    'rechaza loopback/no-especificada/mapeada en representaciones "exóticas" ' +
      '(expandida, mayúsculas, cola IPv4 en hex, forma compatible-deprecada) — ' +
      'un chequeo que solo reconoce UNA forma textual deja pasar las demás',
    () => {
      // Loopback ::1, expandida sin abreviar y con ceros a la izquierda.
      expect(isDisallowedIp('0:0:0:0:0:0:0:1')).toBe(true);
      expect(isDisallowedIp('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
      // No especificada ::, expandida.
      expect(isDisallowedIp('0:0:0:0:0:0:0:0')).toBe(true);
      // Mapeada, cola en HEX puro en vez de decimal-con-puntos (mismo valor
      // que ::ffff:127.0.0.1: 0x7f000001).
      expect(isDisallowedIp('::ffff:7f00:1')).toBe(true);
      expect(isDisallowedIp('0000:0000:0000:0000:0000:ffff:7f00:0001')).toBe(true);
      // Forma "compatible" IPv4 deprecada (sin `ffff`), sigue siendo loopback.
      expect(isDisallowedIp('::127.0.0.1')).toBe(true);
      // Mayúsculas / mixtas.
      expect(isDisallowedIp('::FFFF:127.0.0.1')).toBe(true);
      expect(isDisallowedIp('FE80::1')).toBe(true);
      expect(isDisallowedIp('Fc00::1')).toBe(true);
    },
  );

  it('IPv6 malformada (sintaxis inválida) no se trata como bloqueada ni rompe', () => {
    expect(isDisallowedIp('1:2:3:4:5:6:7:8:9')).toBe(false); // demasiados grupos
    expect(isDisallowedIp('1::2::3')).toBe(false); // doble "::"
    expect(isDisallowedIp('gggg::1')).toBe(false); // hextet no hexadecimal
    expect(isDisallowedIp('not:a:real:address')).toBe(false);
  });
});

describe('parseExternalSiteUrl', () => {
  it('acepta una URL https con host público', () => {
    const res = parseExternalSiteUrl('https://mi-web.example.com/ruta?x=1');
    expect(res).toEqual({ ok: true, hostname: 'mi-web.example.com' });
  });

  it('rechaza esquemas distintos de https', () => {
    expect(parseExternalSiteUrl('http://example.com')).toEqual({
      ok: false,
      reason: 'must_be_https',
    });
    expect(parseExternalSiteUrl('ftp://example.com')).toEqual({
      ok: false,
      reason: 'must_be_https',
    });
  });

  it('rechaza URLs inválidas', () => {
    expect(parseExternalSiteUrl('no-es-una-url')).toEqual({ ok: false, reason: 'invalid_url' });
    expect(parseExternalSiteUrl('')).toEqual({ ok: false, reason: 'invalid_url' });
  });

  it('rechaza IP-literal privada/loopback', () => {
    expect(parseExternalSiteUrl('https://127.0.0.1/')).toEqual({
      ok: false,
      reason: 'private_ip',
    });
    expect(parseExternalSiteUrl('https://[::1]/')).toEqual({
      ok: false,
      reason: 'private_ip',
    });
    expect(parseExternalSiteUrl('https://10.0.0.5:8080/')).toEqual({
      ok: false,
      reason: 'private_ip',
    });
  });

  it('rechaza localhost y *.localhost', () => {
    expect(parseExternalSiteUrl('https://localhost/')).toEqual({
      ok: false,
      reason: 'private_ip',
    });
    expect(parseExternalSiteUrl('https://app.localhost/')).toEqual({
      ok: false,
      reason: 'private_ip',
    });
  });

  it('rechaza los hosts de la propia plataforma', () => {
    expect(
      parseExternalSiteUrl('https://trasteros.pro/', ['trasteros.pro', 'api.trasteros.pro']),
    ).toEqual({
      ok: false,
      reason: 'platform_host',
    });
  });

  it('IPv6 pública en formato URL (con corchetes) se acepta', () => {
    expect(parseExternalSiteUrl('https://[2606:4700:4700::1111]/')).toEqual({
      ok: true,
      hostname: '[2606:4700:4700::1111]',
    });
  });
});
