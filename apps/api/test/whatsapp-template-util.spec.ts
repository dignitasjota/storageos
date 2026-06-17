import { buildWhatsappTemplateParams } from '../src/modules/communications/whatsapp-template.util';

describe('buildWhatsappTemplateParams', () => {
  it('mapea los nombres ordenados a parámetros posicionales 1..N', () => {
    const params = buildWhatsappTemplateParams(['customerName', 'invoiceTotal'], {
      customerName: 'Ana',
      invoiceTotal: '75 €',
      extra: 'ignorada',
    });
    expect(params).toEqual({ '1': 'Ana', '2': '75 €' });
  });

  it('rellena con cadena vacía las variables ausentes y convierte a string', () => {
    const params = buildWhatsappTemplateParams(['a', 'b', 'c'], { a: 10, b: null });
    expect(params).toEqual({ '1': '10', '2': '', '3': '' });
  });

  it('sin variables ordenadas devuelve objeto vacío', () => {
    expect(buildWhatsappTemplateParams([], { a: 'x' })).toEqual({});
  });
});
