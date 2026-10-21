import { createVerify, generateKeyPairSync } from 'node:crypto';

import { GoogleApiError, GoogleServiceAccount } from '../google-service-account';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  client_email: 'seo@trasteros.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

describe('GoogleServiceAccount', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sin JSON o con JSON roto no está configurada', () => {
    expect(new GoogleServiceAccount(undefined).configured).toBe(false);
    expect(new GoogleServiceAccount('no-json').configured).toBe(false);
    expect(new GoogleServiceAccount('{"client_email":"x"}').configured).toBe(false);
  });

  it('firma el JWT con la clave y reutiliza el token por ámbito', async () => {
    const calls: URLSearchParams[] = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(new URLSearchParams(String(init?.body)));
      return new Response(
        JSON.stringify({ access_token: `tok-${calls.length}`, expires_in: 3600 }),
      );
    }) as typeof fetch;
    const account = new GoogleServiceAccount(KEY_JSON);
    expect(account.email).toBe('seo@trasteros.iam.gserviceaccount.com');

    expect(await account.accessToken('scope-a')).toBe('tok-1');
    expect(await account.accessToken('scope-a')).toBe('tok-1');
    expect(await account.accessToken('scope-b')).toBe('tok-2');
    expect(calls).toHaveLength(2);

    const [header, payload, signature] = calls[0]!.get('assertion')!.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({
      iss: 'seo@trasteros.iam.gserviceaccount.com',
      scope: 'scope-a',
      aud: 'https://oauth2.googleapis.com/token',
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(valid).toBe(true);
  });

  it('un error de la API lleva su mensaje y su código', async () => {
    global.fetch = jest.fn(async (url: unknown) =>
      String(url).includes('oauth2')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
        : new Response(
            JSON.stringify({ error: { message: 'User does not have sufficient permissions' } }),
            {
              status: 403,
            },
          ),
    ) as typeof fetch;
    const account = new GoogleServiceAccount(KEY_JSON);
    await expect(
      account.request('s', 'GET', 'https://example.googleapis.com/x'),
    ).rejects.toMatchObject({
      status: 403,
      message: 'User does not have sufficient permissions',
    });
    await expect(
      account.request('s', 'GET', 'https://example.googleapis.com/x'),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });
});
