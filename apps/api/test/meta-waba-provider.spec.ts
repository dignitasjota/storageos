import { MetaWabaProvider } from '../src/modules/communications/providers/meta-waba.provider';

import type { ConfigService } from '@nestjs/config';

function makeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] ?? '' } as unknown as ConfigService;
}

function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  } as Response);
}

describe('MetaWabaProvider', () => {
  const config = makeConfig({
    WHATSAPP_FROM_PHONE_ID: '123456',
    WHATSAPP_ACCESS_TOKEN: 'test-token',
  });

  afterEach(() => jest.restoreAllMocks());

  it('envía texto libre y devuelve el WAMID', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      body: { messages: [{ id: 'wamid.ABC' }] },
    });
    const provider = new MetaWabaProvider(config);

    const res = await provider.send({ to: '+34 600 111 222', body: 'Hola' });

    expect(res.providerMessageId).toBe('wamid.ABC');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v21.0/123456/messages');
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: '34600111222',
      type: 'text',
      text: { body: 'Hola' },
    });
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test-token',
    });
  });

  it('envía plantilla con variables posicionales', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      body: { messages: [{ id: 'wamid.TPL' }] },
    });
    const provider = new MetaWabaProvider(config);

    const res = await provider.send({
      to: '34600111222',
      body: 'fallback',
      templateName: 'invoice_overdue',
      templateLanguage: 'es',
      templateVariables: { 1: 'Ana', 2: '75 €' },
    });

    expect(res.providerMessageId).toBe('wamid.TPL');
    const payload = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(payload.type).toBe('template');
    expect(payload.template.name).toBe('invoice_overdue');
    expect(payload.template.language).toEqual({ code: 'es' });
    expect(payload.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Ana' },
      { type: 'text', text: '75 €' },
    ]);
  });

  it('lanza cuando la API de Meta responde error', async () => {
    mockFetch({
      ok: false,
      status: 400,
      body: { error: { message: 'Invalid phone number' } },
    });
    const provider = new MetaWabaProvider(config);

    await expect(provider.send({ to: 'x', body: 'Hola' })).rejects.toThrow('Invalid phone number');
  });

  it('lanza si faltan las credenciales', async () => {
    const provider = new MetaWabaProvider(makeConfig({}));
    await expect(provider.send({ to: '34600', body: 'Hola' })).rejects.toThrow(
      'WHATSAPP_FROM_PHONE_ID',
    );
  });
});
