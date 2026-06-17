import { HoldedClient } from '../src/modules/accounting/holded.client';

function mockFetch(
  impl: (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown },
) {
  return jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = impl(url, init as RequestInit);
    return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body } as Response);
  });
}

describe('HoldedClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('testConnection llama a /contacts con el header key', async () => {
    const spy = mockFetch(() => ({ ok: true, status: 200, body: [] }));
    await new HoldedClient('k_test').testConnection();
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain('/contacts');
    expect((init as RequestInit).headers).toMatchObject({ key: 'k_test' });
  });

  it('findContact casa por NIF (code)', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      body: [
        { id: 'c1', code: '11111111H', email: 'a@a.com' },
        { id: 'c2', code: '12345678Z', email: 'b@b.com' },
      ],
    }));
    const id = await new HoldedClient('k').findContact('12345678Z', undefined);
    expect(id).toBe('c2');
  });

  it('createInvoice devuelve el id del documento', async () => {
    mockFetch(() => ({ ok: true, status: 200, body: { status: 1, id: 'doc_99' } }));
    const id = await new HoldedClient('k').createInvoice({
      contactId: 'c1',
      date: 1700000000,
      items: [{ name: 'Alquiler', units: 1, price: 50, tax: 21 }],
    });
    expect(id).toBe('doc_99');
  });

  it('lanza ante error HTTP de Holded', async () => {
    mockFetch(() => ({ ok: false, status: 401, body: { message: 'Invalid API key' } }));
    await expect(new HoldedClient('bad').testConnection()).rejects.toThrow('Invalid API key');
  });

  it('lanza ante error lógico (status 0) con HTTP 200', async () => {
    mockFetch(() => ({ ok: true, status: 200, body: { status: 0, info: 'contacto inválido' } }));
    await expect(
      new HoldedClient('k').createContact({ name: 'X', isPerson: true }),
    ).rejects.toThrow('contacto inválido');
  });
});
