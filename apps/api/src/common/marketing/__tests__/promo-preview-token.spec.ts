import {
  buildPromoPreviewToken,
  promoPreviewKey,
  verifyPromoPreviewToken,
} from '../promo-preview-token';

describe('promo-preview-token', () => {
  const key = promoPreviewKey('clave-maestra');
  const id = '0190f0f0-0000-7000-8000-000000000001';

  it('devuelve la landing con un token válido', () => {
    const token = buildPromoPreviewToken(key, id, Date.now() + 60_000);
    expect(verifyPromoPreviewToken(key, token)).toBe(id);
  });

  it('rechaza un token caducado, de otra clave o manipulado', () => {
    const expired = buildPromoPreviewToken(key, id, Date.now() - 1);
    expect(verifyPromoPreviewToken(key, expired)).toBeNull();
    const token = buildPromoPreviewToken(key, id, Date.now() + 60_000);
    expect(verifyPromoPreviewToken(promoPreviewKey('otra'), token)).toBeNull();
    const [, exp, sig] = token.split('.');
    expect(
      verifyPromoPreviewToken(key, `0190f0f0-0000-7000-8000-000000000002.${exp}.${sig}`),
    ).toBeNull();
    expect(verifyPromoPreviewToken(key, 'basura')).toBeNull();
  });
});
