import { stripRedirectUriOnCodeExchange } from '../sistrix/mcp-fetch';

describe('Canje del código con SISTRIX sin `redirect_uri`', () => {
  const capture = () => {
    const calls: { url: string; body: string }[] = [];
    const inner = jest.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? String(init.body) : '' });
      return new Response('{}', { status: 200 });
    });
    return { calls, fetchFn: stripRedirectUriOnCodeExchange(inner) };
  };

  it('quita `redirect_uri` solo de la petición con grant_type=authorization_code', async () => {
    const { calls, fetchFn } = capture();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'abc',
      code_verifier: 'v',
      redirect_uri: 'https://api.trasteros.pro/v1/admin/seo/sistrix/callback',
      resource: 'https://api.sistrix.com/mcp',
    });
    await fetchFn('https://api.sistrix.com/mcp/token', { method: 'POST', body });
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.has('redirect_uri')).toBe(false);
    expect(sent.get('code')).toBe('abc');
    expect(sent.get('resource')).toBe('https://api.sistrix.com/mcp');
  });

  it('también si el cuerpo va como texto', async () => {
    const { calls, fetchFn } = capture();
    await fetchFn('https://x/token', {
      method: 'POST',
      body: 'grant_type=authorization_code&code=a&redirect_uri=https%3A%2F%2Fapi%2Fcb',
    });
    expect(new URLSearchParams(calls[0]!.body).has('redirect_uri')).toBe(false);
  });

  it('la renovación, el registro y el resto pasan sin tocar', async () => {
    const { calls, fetchFn } = capture();
    const refresh = 'grant_type=refresh_token&refresh_token=r&redirect_uri=x';
    await fetchFn('https://x/token', { method: 'POST', body: refresh });
    await fetchFn('https://x/register', { method: 'POST', body: '{"redirect_uris":["x"]}' });
    await fetchFn('https://x/.well-known/oauth-authorization-server');
    expect(calls[0]!.body).toBe(refresh);
    expect(calls[1]!.body).toBe('{"redirect_uris":["x"]}');
    expect(calls).toHaveLength(3);
  });
});
