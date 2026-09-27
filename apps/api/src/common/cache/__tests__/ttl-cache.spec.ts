import { TtlCache } from '../ttl-cache';

describe('TtlCache', () => {
  it('reutiliza el valor dentro del TTL y recarga al caducar', async () => {
    let now = 1_000;
    const cache = new TtlCache<number>(60_000, () => now);
    const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.get('k', load)).toBe(1);
    now += 30_000;
    expect(await cache.get('k', load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    now += 31_000;
    expect(await cache.get('k', load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('comparte la promesa entre peticiones concurrentes y separa por clave', async () => {
    const cache = new TtlCache<string>(60_000);
    const load = jest.fn(async () => 'x');
    await Promise.all([cache.get('a', load), cache.get('a', load), cache.get('b', load)]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('no cachea errores', async () => {
    const cache = new TtlCache<number>(60_000);
    const load = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(7);
    await expect(cache.get('k', load)).rejects.toThrow('boom');
    expect(await cache.get('k', load)).toBe(7);
  });

  it('con TTL 0 no cachea', async () => {
    const cache = new TtlCache<number>(0);
    const load = jest.fn().mockResolvedValue(3);
    await cache.get('k', load);
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
