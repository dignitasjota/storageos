import { BrevoEmailProvider, buildBrevoPayload } from '../providers/brevo.provider';
import { formatAddress, sanitizeDisplayName } from '../providers/email-provider';

import type { Env } from '../../../config/env.schema';
import type { ConfigService } from '@nestjs/config';

function config(values: Partial<Record<keyof Env, unknown>>): ConfigService<Env, true> {
  return { get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>;
}

const PLATFORM = { name: 'TrasterOS', email: 'no-reply@trasteros.pro' };

describe('Brevo provider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('usa el remitente por defecto y no manda replyTo si no hay', () => {
    const body = buildBrevoPayload(
      { to: 'a@x.com', subject: 'Hola', html: '<p>h</p>', text: 'h' },
      PLATFORM,
    );
    expect(body).toEqual({
      sender: PLATFORM,
      to: [{ email: 'a@x.com' }],
      subject: 'Hola',
      htmlContent: '<p>h</p>',
      textContent: 'h',
    });
  });

  it('respeta remitente, respuesta y tags', () => {
    const body = buildBrevoPayload(
      {
        to: 'a@x.com',
        subject: 's',
        html: 'h',
        text: 't',
        from: { name: 'Trasteros "García"\r\nBcc: x', email: 'no-reply@trasteros.pro' },
        replyTo: { email: 'info@garcia.es' },
        tags: { tenantId: 't1' },
      },
      PLATFORM,
    );
    expect(body.sender).toEqual({
      name: 'Trasteros García Bcc: x',
      email: 'no-reply@trasteros.pro',
    });
    expect(body.replyTo).toEqual({ email: 'info@garcia.es' });
    expect(body.tags).toEqual(['tenantId:t1']);
  });

  it('envía con la api-key y devuelve el messageId', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ messageId: '<abc@brevo>' }), { status: 201 }),
      );
    const provider = new BrevoEmailProvider(
      config({
        BREVO_API_KEY: 'xkeysib-1',
        EMAIL_FROM_NAME: PLATFORM.name,
        EMAIL_FROM_ADDRESS: PLATFORM.email,
      }),
    );
    const res = await provider.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' });
    expect(res.providerMessageId).toBe('<abc@brevo>');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init!.headers as Record<string, string>)['api-key']).toBe('xkeysib-1');
  });

  it('lanza si Brevo rechaza el envío o falta la clave', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'sender not valid' }), { status: 400 }),
      );
    const ok = new BrevoEmailProvider(
      config({ BREVO_API_KEY: 'k', EMAIL_FROM_NAME: 'T', EMAIL_FROM_ADDRESS: 'n@t.pro' }),
    );
    await expect(ok.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow(
      'sender not valid',
    );
    const noKey = new BrevoEmailProvider(config({ BREVO_API_KEY: '' }));
    await expect(noKey.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow(
      'BREVO_API_KEY',
    );
  });

  it('formatea direcciones sin permitir inyección de cabeceras', () => {
    expect(formatAddress({ email: 'n@t.pro' })).toBe('n@t.pro');
    expect(formatAddress({ name: 'A <b>\n"c"', email: 'n@t.pro' })).toBe('"A b c" <n@t.pro>');
    expect(sanitizeDisplayName('   ')).toBe('');
  });
});
