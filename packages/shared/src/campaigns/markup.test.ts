import { describe, expect, it } from 'vitest';

import { campaignMarkupToHtml, campaignMarkupToText } from './markup';

describe('formato del mensaje', () => {
  const text =
    'Hola **Ana**,\n\nMira [la oferta](https://a.es/o?x=1&y=2) o https://a.es/p.\n[[boton: Reservar ahora | https://a.es/reservar]]\nUn saludo';

  it('texto plano sin formato y con los enlaces a la vista', () => {
    expect(campaignMarkupToText(text)).toBe(
      'Hola Ana,\n\nMira la oferta (https://a.es/o?x=1&y=2) o https://a.es/p.\nReservar ahora: https://a.es/reservar\nUn saludo',
    );
  });

  it('HTML con negrita, enlaces con texto, botón y seguimiento', () => {
    const html = campaignMarkupToHtml(text, {
      brandColor: '#ff6600',
      hrefFor: (u) => `https://api/click?u=${encodeURIComponent(u)}`,
    });
    expect(html).toContain('<strong>Ana</strong>');
    expect(html).toContain(
      `<a href="https://api/click?u=${encodeURIComponent('https://a.es/o?x=1&y=2')}" style="color:#2563eb">la oferta</a>`,
    );
    expect(html).toContain('>https://a.es/p</a>.');
    expect(html).toContain('background:#ff6600');
    expect(html).toContain('>Reservar ahora</a>');
    expect(html).toContain('Un saludo');
  });

  it('escapa el HTML que escriba el negocio y un color raro', () => {
    const html = campaignMarkupToHtml('<script>x</script> **<b>**', { brandColor: 'red;x' });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('<strong>&lt;b&gt;</strong>');
    expect(campaignMarkupToHtml('[[boton: Ir | https://a.es]]', { brandColor: 'red' })).toContain(
      'background:#2563eb',
    );
  });
});
