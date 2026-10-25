import { buildClickToken, clickKey, extractLinks, parseClickToken } from '../click-token';

describe('click-token', () => {
  const key = clickKey('clave-maestra');
  const link = '0190a1b2-0000-7000-8000-000000000001';
  const customer = '0190a1b2-0000-7000-8000-000000000002';

  it('firma y lee el destinatario', () => {
    const token = buildClickToken(key, link, 'c', customer);
    expect(parseClickToken(key, token)).toEqual({ linkId: link, recipientKey: `c:${customer}` });
  });

  it('rechaza un token manipulado o con otra clave', () => {
    const token = buildClickToken(key, link, 'c', customer);
    expect(parseClickToken(clickKey('otra'), token)).toBeNull();
    expect(parseClickToken(key, token.replace(`.c${customer}`, `.l${customer}`))).toBeNull();
    expect(parseClickToken(key, 'basura')).toBeNull();
  });

  it('saca los enlaces del texto sin la puntuación final', () => {
    expect(
      extractLinks('Mira https://web.es/oferta. Y reserva en https://web.es/reservar?c=X, ¡ya!'),
    ).toEqual(['https://web.es/oferta', 'https://web.es/reservar?c=X']);
  });
});
