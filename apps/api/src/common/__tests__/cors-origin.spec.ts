import { CORS_ORIGIN_MAX_CACHE_ENTRIES, createCorsOrigin } from '../cors-origin';

type Cb = (err: Error | null, allow?: boolean) => void;

function call(
  fn: (origin: string | undefined, cb: Cb) => void,
  origin: string | undefined,
): Promise<boolean | undefined> {
  return new Promise((resolve, reject) => {
    fn(origin, (err, allow) => (err ? reject(err) : resolve(allow)));
  });
}

describe('createCorsOrigin', () => {
  it('sin Origin (curl/same-origin) siempre permite, sin consultar la BD', async () => {
    const isVerified = jest.fn();
    const cors = createCorsOrigin(['https://app.example.com'], isVerified);
    expect(await call(cors, undefined)).toBe(true);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it('un origin de la whitelist fija permite sin consultar la BD', async () => {
    const isVerified = jest.fn();
    const cors = createCorsOrigin(['https://app.example.com'], isVerified);
    expect(await call(cors, 'https://app.example.com')).toBe(true);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it('Origin ilegible (URL inválida) se rechaza sin consultar la BD', async () => {
    const isVerified = jest.fn();
    const cors = createCorsOrigin([], isVerified);
    expect(await call(cors, 'no-es-una-url')).toBe(false);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it('dominio verificado permite y cachea (2ª llamada no vuelve a consultar)', async () => {
    const isVerified = jest.fn().mockResolvedValue(true);
    const cors = createCorsOrigin([], isVerified);
    expect(await call(cors, 'https://tenant.example.com')).toBe(true);
    expect(await call(cors, 'https://tenant.example.com')).toBe(true);
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it('dominio no verificado deniega y también cachea el negativo', async () => {
    const isVerified = jest.fn().mockResolvedValue(false);
    const cors = createCorsOrigin([], isVerified);
    expect(await call(cors, 'https://ajeno.example.com')).toBe(false);
    expect(await call(cors, 'https://ajeno.example.com')).toBe(false);
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it('un fallo de la consulta a BD deniega y NO cachea (reintenta la próxima vez)', async () => {
    const isVerified = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(true);
    const cors = createCorsOrigin([], isVerified);
    expect(await call(cors, 'https://tenant.example.com')).toBe(false);
    expect(await call(cors, 'https://tenant.example.com')).toBe(true);
    expect(isVerified).toHaveBeenCalledTimes(2);
  });

  it(
    'el caché de hosts NO crece sin límite: pasado el tope, el host más antiguo se ' +
      'desaloja (regresión del hueco de memoria — el Origin lo controla el atacante)',
    async () => {
      const isVerified = jest.fn().mockResolvedValue(true);
      const cors = createCorsOrigin([], isVerified);

      // Llena el caché hasta el tope con hosts distintos.
      for (let i = 0; i < CORS_ORIGIN_MAX_CACHE_ENTRIES; i++) {
        await call(cors, `https://host-${i}.example.com`);
      }
      expect(isVerified).toHaveBeenCalledTimes(CORS_ORIGIN_MAX_CACHE_ENTRIES);

      // Un host más (el (tope+1)-ésimo) desaloja el primero insertado (FIFO).
      await call(cors, 'https://host-overflow.example.com');
      expect(isVerified).toHaveBeenCalledTimes(CORS_ORIGIN_MAX_CACHE_ENTRIES + 1);

      // El primer host (host-0) ya no está en caché → vuelve a consultar la BD.
      await call(cors, 'https://host-0.example.com');
      expect(isVerified).toHaveBeenCalledTimes(CORS_ORIGIN_MAX_CACHE_ENTRIES + 2);

      // Un host reciente (host-999, muy por delante del que se desalojó) sigue cacheado.
      await call(cors, 'https://host-999.example.com');
      expect(isVerified).toHaveBeenCalledTimes(CORS_ORIGIN_MAX_CACHE_ENTRIES + 2);
    },
    15_000,
  );
});
