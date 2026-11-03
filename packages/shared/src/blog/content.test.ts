import { describe, expect, it } from 'vitest';

import { blogImageFileName, comparisonBlock, parseWebLink, splitBlogContent } from './content';

describe('parseWebLink', () => {
  it('lee secciones y páginas', () => {
    expect(parseWebLink('web:precios')).toEqual({ kind: 'section', section: 'precios' });
    expect(parseWebLink('web:local/centro-norte')).toEqual({ kind: 'local', slug: 'centro-norte' });
    expect(parseWebLink('web:post/cuantos-metros')).toEqual({
      kind: 'post',
      slug: 'cuantos-metros',
    });
  });
  it('rechaza lo que no es un destino válido', () => {
    expect(parseWebLink('web:otra')).toBeNull();
    expect(parseWebLink('web:local/../admin')).toBeNull();
    expect(parseWebLink('web:local/a/b')).toBeNull();
    expect(parseWebLink('https://x.com')).toBeNull();
  });
});

describe('splitBlogContent', () => {
  it('saca botones y widgets en líneas propias', () => {
    const md = [
      '## ¿Cuántos metros necesitas?',
      'Texto.',
      '[[boton: Consultar trasteros disponibles | web:precios]]',
      '[[calculadora]]',
      '[[Tamaños]]',
      'Final.',
    ].join('\n');
    expect(splitBlogContent(md)).toEqual([
      { type: 'markdown', text: '## ¿Cuántos metros necesitas?\nTexto.' },
      { type: 'button', label: 'Consultar trasteros disponibles', href: 'web:precios' },
      { type: 'widget', widget: 'calculadora' },
      { type: 'widget', widget: 'tamanos' },
      { type: 'markdown', text: 'Final.' },
    ]);
  });
  it('deja como texto lo mal escrito y lo que va en bloques de código', () => {
    const md = [
      '```',
      '[[calculadora]]',
      '```',
      '[[boton: Sin destino]]',
      '[[boton: X | javascript:alert(1)]]',
    ].join('\n');
    const blocks = splitBlogContent(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('markdown');
  });
});

describe('blogImageFileName', () => {
  it('limpia el nombre del fichero', () => {
    expect(blogImageFileName('Trastero Pequeño Madrid.JPG')).toBe('trastero-pequeno-madrid');
  });
});

describe('comparativa', () => {
  const block = [
    'Intro.',
    '[[comparativa]]',
    'https://x.com/a.jpg | Pequeño | Para cajas',
    ' | Mediano | ',
    '[[/comparativa]]',
    'Final.',
  ].join('\n');
  it('lee una columna por línea', () => {
    expect(splitBlogContent(block)).toEqual([
      { type: 'markdown', text: 'Intro.' },
      {
        type: 'comparison',
        columns: [
          { imageUrl: 'https://x.com/a.jpg', title: 'Pequeño', subtitle: 'Para cajas' },
          { imageUrl: null, title: 'Mediano', subtitle: null },
        ],
      },
      { type: 'markdown', text: 'Final.' },
    ]);
  });
  it('mal escrita se queda como texto', () => {
    const one = '[[comparativa]]\nhttps://x.com/a.jpg | Solo una\n[[/comparativa]]';
    expect(splitBlogContent(one)).toEqual([{ type: 'markdown', text: one }]);
    const five = ['[[comparativa]]', ...Array(5).fill(' | A | '), '[[/comparativa]]'].join('\n');
    expect(splitBlogContent(five)[0]!.type).toBe('markdown');
    const http = '[[comparativa]]\nhttp://x.com/a.jpg | A\n | B\n[[/comparativa]]';
    expect(splitBlogContent(http)[0]!.type).toBe('markdown');
    expect(splitBlogContent('[[comparativa]]\n | A\n | B')[0]!.type).toBe('markdown');
  });
  it('se genera y se vuelve a leer igual', () => {
    const cols = [
      { imageUrl: 'https://x.com/a.jpg', title: 'A | b', subtitle: null },
      { imageUrl: null, title: 'C', subtitle: 'D' },
    ];
    const parsed = splitBlogContent(comparisonBlock(cols));
    expect(parsed[0]).toEqual({
      type: 'comparison',
      columns: [
        { imageUrl: 'https://x.com/a.jpg', title: 'A b', subtitle: null },
        { imageUrl: null, title: 'C', subtitle: 'D' },
      ],
    });
  });
});
