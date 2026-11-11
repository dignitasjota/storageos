import { verifactuDeclaration } from '@storageos/shared';

import { renderDeclarationHtml } from '../verifactu-declaration-template';

describe('renderDeclarationHtml', () => {
  const doc = verifactuDeclaration()!;

  it('empieza por el título y lleva cada dato con su texto, en orden', () => {
    const html = renderDeclarationHtml(doc);
    const body = html.slice(html.indexOf('<body>'));
    expect(
      body.indexOf('<h1>DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN</h1>'),
    ).toBeGreaterThan(-1);
    let last = body.indexOf('<h1>');
    for (const item of [...doc.items, ...doc.contact]) {
      const at = body.indexOf(`<div class="label">${item.label}:</div>`, last);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(body).toContain('Urbanbox Soluciones SL');
    expect(body).toContain('B05691886');
  });

  it('un párrafo por bloque y el texto escapado', () => {
    const html = renderDeclarationHtml({
      ...doc,
      items: [{ key: 'd', label: 'Componentes', value: 'Uno <b>dos</b>\n\nTres & cuatro' }],
      contact: [],
    });
    expect(html).toContain('<p>Uno &lt;b&gt;dos&lt;/b&gt;</p><p>Tres &amp; cuatro</p>');
    expect(html).not.toContain('<b>dos</b>');
  });
});
