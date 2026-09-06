import { isSafeOutboundUrl } from '../security/safe-outbound-url';

describe('isSafeOutboundUrl — SSRF de controlUrl de dispositivos', () => {
  it('rechaza IPs privadas/loopback literales sin necesitar DNS', async () => {
    for (const url of [
      'http://127.0.0.1:8080/open',
      'http://10.0.0.5/open',
      'http://192.168.1.1/open',
      'http://[::1]/open',
    ]) {
      const res = await isSafeOutboundUrl(url);
      expect(res.safe).toBe(false);
      expect(res.reason).toBe('private_ip');
    }
  });

  it('acepta una IP pública literal sin resolución DNS', async () => {
    const res = await isSafeOutboundUrl('https://93.184.216.34/open');
    expect(res.safe).toBe(true);
  });

  it('acepta http:// (a diferencia de parseExternalSiteUrl, no exige https)', async () => {
    const res = await isSafeOutboundUrl('http://93.184.216.34:8080/open');
    expect(res.safe).toBe(true);
  });

  it('URL inválida → unsafe sin lanzar', async () => {
    const res = await isSafeOutboundUrl('no-es-una-url');
    expect(res.safe).toBe(false);
    expect(res.reason).toBe('invalid_url');
  });
});
