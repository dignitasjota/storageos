import { textToHtmlWithLinks } from '../../tenant-email-layout';
import { extractLinks, splitLinks } from '../click-token';

describe('splitLinks / textToHtmlWithLinks', () => {
  it('separa texto y enlaces sin la puntuación final', () => {
    expect(splitLinks('Mira https://a.es/x?y=1&z=2. Y ya')).toEqual([
      { text: 'Mira ', link: false },
      { text: 'https://a.es/x?y=1&z=2', link: true },
      { text: '. Y ya', link: false },
    ]);
    expect(extractLinks('https://a.es y https://a.es, https://b.es')).toEqual([
      'https://a.es',
      'https://b.es',
    ]);
  });

  it('muestra la dirección escrita y lleva al enlace con seguimiento', () => {
    const html = textToHtmlWithLinks('Hola <b>\n\nReserva en https://a.es/x?y=1&z=2.', (u) =>
      u === 'https://a.es/x?y=1&z=2' ? 'https://api/click/abc' : u,
    );
    expect(html).toContain('Hola &lt;b&gt;');
    expect(html).toContain(
      '<a href="https://api/click/abc" style="color:#2563eb">https://a.es/x?y=1&amp;z=2</a>.',
    );
  });
});
