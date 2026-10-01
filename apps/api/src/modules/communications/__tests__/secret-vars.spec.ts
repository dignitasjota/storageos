import { extractSecrets, fillSecrets, maskSecrets, SECRET_MASK } from '../secret-vars';

describe('secret-vars', () => {
  it('separa el valor sensible: marca para renderizar, «••••» para guardar', () => {
    const vars = { credential: { secret: '483920' }, tenant: { name: 'Acme' } };
    const { forRender, forStorage, secrets } = extractSecrets(vars, ['credential.secret']);
    expect(forRender).toEqual({ credential: { secret: '[[SECRET-0]]' }, tenant: { name: 'Acme' } });
    expect(forStorage).toEqual({ credential: { secret: SECRET_MASK }, tenant: { name: 'Acme' } });
    expect(secrets).toEqual({ '[[SECRET-0]]': '483920' });
    // No muta las variables originales.
    expect(vars.credential.secret).toBe('483920');
  });

  it('sin valor sensible no hay nada que cifrar', () => {
    const r = extractSecrets({ credential: {} }, ['credential.secret', 'otro.camino']);
    expect(r.secrets).toBeNull();
  });

  it('rellena al enviar y tapa al mostrar', () => {
    const body = 'Tu código: [[SECRET-0]]. Repito: [[SECRET-0]]';
    expect(fillSecrets(body, { '[[SECRET-0]]': '483920' })).toBe(
      'Tu código: 483920. Repito: 483920',
    );
    expect(maskSecrets(body)).toBe(`Tu código: ${SECRET_MASK}. Repito: ${SECRET_MASK}`);
  });
});
