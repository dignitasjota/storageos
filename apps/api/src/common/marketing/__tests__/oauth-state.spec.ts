import { buildOauthState, oauthStateKey, parseOauthState } from '../oauth-state';

describe('estado firmado de «Conectar con Facebook»', () => {
  const key = oauthStateKey('una-clave-maestra-de-prueba-0123456789abcdef');
  const tenantId = '0190f5c2-1111-7000-8000-000000000001';
  const userId = '0190f5c2-2222-7000-8000-000000000002';

  it('devuelve el negocio y el usuario del estado que firmamos', () => {
    const state = buildOauthState(key, tenantId, userId);
    expect(parseOauthState(key, state)).toEqual({ tenantId, userId });
  });

  it('rechaza un estado tocado, de otra clave o caducado', () => {
    const state = buildOauthState(key, tenantId, userId);
    const other = '0190f5c2-3333-7000-8000-000000000003';
    expect(parseOauthState(key, state.replace(tenantId, other))).toBeNull();
    expect(parseOauthState(oauthStateKey('otra-clave-maestra-0123456789abcdef'), state)).toBeNull();
    const old = buildOauthState(key, tenantId, userId, 60_000, Date.now() - 120_000);
    expect(parseOauthState(key, old)).toBeNull();
    expect(parseOauthState(key, 'basura')).toBeNull();
    expect(parseOauthState(key, `${tenantId}.${userId}.123.firma`)).toBeNull();
  });
});
