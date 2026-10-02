import {
  extractBody,
  TENANT_SHELL_MARK,
  tenantEmailShell,
  textToHtml,
} from '../tenant-email-layout';

describe('tenant-email-layout', () => {
  const brand = { name: 'Trasteros <Pepe>', logoUrl: null, brandColor: '#ff6600' };

  it('carcasa con nombre escapado, color de marca y marca de «ya envuelto»', () => {
    const html = tenantEmailShell(brand, '<p>Hola</p>');
    expect(html).toContain(TENANT_SHELL_MARK);
    expect(html).toContain('Trasteros &lt;Pepe&gt;');
    expect(html).toContain('#ff6600');
    expect(html).toContain('<p>Hola</p>');
  });

  it('con logo usa la imagen; un color o logo raros no se incrustan', () => {
    const withLogo = tenantEmailShell({ ...brand, logoUrl: 'https://cdn.x/logo.png' }, '<p>x</p>');
    expect(withLogo).toContain('<img src="https://cdn.x/logo.png"');
    const bad = tenantEmailShell(
      { name: 'X', logoUrl: 'javascript:alert(1)', brandColor: 'red;background:url(x)' },
      '',
    );
    expect(bad).not.toContain('javascript:');
    expect(bad).not.toContain('url(x)');
    expect(bad).toContain('#2563eb');
  });

  it('texto plano → párrafos con enlaces clicables y escapado', () => {
    const html = textToHtml('Hola <b>Ana</b>,\n\nPaga aquí: https://x.es/p?a=1&b=2.\nGracias');
    expect(html).toContain('Hola &lt;b&gt;Ana&lt;/b&gt;,');
    expect(html).toContain('<a href="https://x.es/p?a=1&amp;b=2"');
    expect(html).toContain('<br>Gracias');
  });

  it('extrae el cuerpo de una plantilla y quita el pie genérico', () => {
    const tpl =
      '<!DOCTYPE html><html><body style="x"><h2>T</h2><p>Hola</p>\n<hr style="a" />\n<p style="font-size:12px;color:#888;">Enviado por Pepe.</p>\n</body></html>';
    expect(extractBody(tpl)).toBe('<h2>T</h2><p>Hola</p>');
  });
});
