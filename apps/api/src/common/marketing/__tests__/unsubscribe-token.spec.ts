import {
  appendUnsubscribeFooter,
  buildUnsubscribeToken,
  maskEmail,
  parseUnsubscribeToken,
  unsubscribeKey,
} from '../unsubscribe-token';

const ID = '0192f0b2-1111-7000-8000-000000000001';

describe('unsubscribe-token', () => {
  const key = unsubscribeKey('clave-maestra');

  it('el token identifica al destinatario y no se puede falsificar', () => {
    const token = buildUnsubscribeToken(key, 'c', ID);
    expect(parseUnsubscribeToken(key, token)).toEqual({ kind: 'c', id: ID });
    // Otra persona, otra clave o firma tocada → inválido.
    const [, , sig] = token.split('.');
    expect(parseUnsubscribeToken(key, `l.${ID}.${sig}`)).toBeNull();
    expect(parseUnsubscribeToken(unsubscribeKey('otra'), token)).toBeNull();
    expect(parseUnsubscribeToken(key, `${token}x`)).toBeNull();
    expect(parseUnsubscribeToken(key, 'basura')).toBeNull();
  });

  it('oculta el email', () => {
    expect(maskEmail('juan@gmail.com')).toBe('j***@gmail.com');
  });

  it('añade el pie de baja al texto y antes de </body>', () => {
    const out = appendUnsubscribeFooter(
      { text: 'Hola', html: '<html><body><p>Hola</p></body></html>' },
      'https://x/unsubscribe/t',
      'Trasteros Pepe',
    );
    expect(out.text).toContain('Darme de baja de estas comunicaciones: https://x/unsubscribe/t');
    expect(out.html).toMatch(/Darme de baja de estas comunicaciones<\/a><\/p><\/body>/);
    expect(out.html).toContain('cliente de Trasteros Pepe');
  });
});
