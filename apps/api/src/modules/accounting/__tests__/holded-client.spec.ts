import { HoldedApiError, HoldedClient } from '../holded.client';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(
  impl: (url: string, method: string, body: unknown) => { status: number; body: unknown },
) {
  const calls: Call[] = [];
  jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers: init?.headers as Record<string, string>, body });
    const r = impl(url, method, body);
    return Promise.resolve({
      ok: r.status < 400,
      status: r.status,
      json: async () => r.body,
    } as Response);
  });
  return calls;
}

describe('HoldedClient (API v2)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('autentica con Bearer contra la v2', async () => {
    const calls = mockFetch(() => ({ status: 200, body: { items: [] } }));
    await new HoldedClient('pat_x_y').testConnection();
    expect(calls[0]!.url).toBe('https://api.holded.com/api/v2/contacts?limit=1');
    expect(calls[0]!.headers.authorization).toBe('Bearer pat_x_y');
  });

  it('401 explica que hace falta una clave pat_ de la v2', async () => {
    mockFetch(() => ({ status: 401, body: { title: 'Unauthorized' } }));
    await expect(new HoldedClient('vieja').testConnection()).rejects.toThrow(/pat_/);
  });

  it('listSeries mapea verifactu_excluded', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        items: [
          { id: 's1', name: 'Normal', format: 'F-%%%', verifactu_excluded: false },
          { id: 's2', name: 'TrasterOS', format: 'TRA-%%%', verifactu_excluded: true },
        ],
      },
    }));
    const series = await new HoldedClient('k').listSeries('invoice');
    expect(series.map((s) => [s.id, s.verifactuExcluded])).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
  });

  it('taxKeyFor elige el IVA repercutido del porcentaje (no el soportado ni el recargo)', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        items: [
          { key: 'p_iva_21', amount: 21 },
          { key: 's_rec_21', amount: 21 },
          { key: 's_iva_21', amount: 21 },
          { key: 's_iva_0', amount: '0' },
        ],
      },
    }));
    const c = new HoldedClient('k');
    expect(await c.taxKeyFor(21)).toBe('s_iva_21');
    expect(await c.taxKeyFor(0)).toBe('s_iva_0');
    await expect(c.taxKeyFor(10)).rejects.toBeInstanceOf(HoldedApiError);
  });

  it('findContact busca por NIF y luego por email', async () => {
    const calls = mockFetch((url) => ({
      status: 200,
      body: { items: url.includes('email=') ? [{ id: 'c9' }] : [] },
    }));
    expect(await new HoldedClient('k').findContact('12345678Z', 'a@b.com')).toBe('c9');
    expect(calls[0]!.url).toContain('code=12345678Z');
    expect(calls[1]!.url).toContain('email=a%40b.com');
  });

  it('createDocument crea en la serie y approveDocument lo aprueba aparte', async () => {
    const calls = mockFetch((url) => ({
      status: url.endsWith('/approve') ? 200 : 201,
      body: { id: 'inv1' },
    }));
    const id = await new HoldedClient('k').createDocument('creditnote', {
      contactId: 'c1',
      date: '2026-10-01',
      seriesId: 'ser-r',
      description: 'Factura rectificativa R-1',
      lines: [{ name: 'Abono', units: 1, price: 10, taxes: ['s_iva_21'] }],
    });
    expect(id).toBe('inv1');
    expect(calls).toHaveLength(1);
    await new HoldedClient('k').approveDocument('creditnote', id);
    expect(calls[0]!.url).toMatch(/\/credit-notes$/);
    expect(calls[0]!.body).toMatchObject({ contact_id: 'c1', number_line_id: 'ser-r' });
    expect(calls[1]!.url).toMatch(/\/credit-notes\/inv1\/approve$/);
  });

  it('addInvoicePayment envía el importe con dos decimales', async () => {
    const calls = mockFetch(() => ({ status: 201, body: {} }));
    await new HoldedClient('k').addInvoicePayment('inv1', { amount: 12.1, date: '2026-10-01' });
    expect(calls[0]!.url).toMatch(/\/invoices\/inv1\/payments$/);
    expect(calls[0]!.body).toMatchObject({ amount: '12.10', date: '2026-10-01' });
  });
});
