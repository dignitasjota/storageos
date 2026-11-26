import {
  decodeHtmlEntities,
  parseSeoHtml,
  resolveSeoHref,
  seoRobotsDirectives,
} from '../crawler/seo-html';

const PAGE = 'https://ejemplo.es/trasteros/valencia';

describe('parseSeoHtml', () => {
  it('lee título, descripción, robots, h1, canónica, idiomas, JSON-LD, imágenes y enlaces', () => {
    const html = `<!doctype html>
<html lang="es-ES"><head>
  <!-- <title>Comentado</title> -->
  <title>Trasteros en Valencia &amp; alrededores · Ejemplo</title>
  <meta name="description" content="Alquila tu trastero &quot;sin permanencia&quot;">
  <meta name="ROBOTS" content="noindex, follow">
  <link rel="canonical" href="/trasteros/valencia/">
  <link rel="canonical" href="https://otra.es/">
  <link rel="alternate" hreflang="es" href="https://ejemplo.es/trasteros/valencia">
  <link rel="alternate" hreflang="en" href="/en/storage/valencia">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"SelfStorage"},{"@type":["Organization","LocalBusiness"]}]}</script>
  <script type="application/ld+json">{ roto </script>
  <script>var x = "<a href='/no-cuenta'>x</a>";</script>
  <style>.a{background:url(<h1>no</h1>)}</style>
</head><body>
  <svg><title>Icono</title></svg>
  <h1>Trasteros en <span>Valencia</span></h1>
  <h1>Otro</h1>
  <img src="a.jpg" alt="Fachada">
  <img src="b.jpg" alt="">
  <img src="c.jpg">
  <a href="precios">Precios</a>
  <a href='/contacto#form' rel="nofollow">Contacto</a>
  <a href=/contacto>Contacto otra vez</a>
  <a href="mailto:hola@ejemplo.es">Correo</a>
  <a href="#arriba">Arriba</a>
  <a href="https://facebook.com/ejemplo">Facebook</a>
</body></html>`;
    const p = parseSeoHtml(html, PAGE);
    expect(p.title).toBe('Trasteros en Valencia & alrededores · Ejemplo');
    expect(p.description).toBe('Alquila tu trastero "sin permanencia"');
    expect(p.robots).toBe('noindex, follow');
    expect(p.h1).toEqual(['Trasteros en Valencia', 'Otro']);
    expect(p.canonical).toBe('https://ejemplo.es/trasteros/valencia/');
    expect(p.canonicalCount).toBe(2);
    expect(p.hreflang).toEqual([
      { lang: 'es', href: 'https://ejemplo.es/trasteros/valencia' },
      { lang: 'en', href: 'https://ejemplo.es/en/storage/valencia' },
    ]);
    expect(p.jsonLdTypes.sort()).toEqual(['LocalBusiness', 'Organization', 'SelfStorage']);
    expect(p.jsonLdInvalid).toBe(1);
    expect(p.imagesTotal).toBe(3);
    expect(p.imagesWithoutAlt).toBe(1);
    expect(p.links).toEqual([
      { href: 'https://ejemplo.es/trasteros/precios', nofollow: false },
      { href: 'https://ejemplo.es/contacto', nofollow: false },
      { href: 'https://facebook.com/ejemplo', nofollow: false },
    ]);
    expect(p.lang).toBe('es-ES');
  });

  it('respeta <base> y tolera una página sin nada', () => {
    const p = parseSeoHtml('<base href="https://ejemplo.es/blog/"><a href="entrada">x</a>', PAGE);
    expect(p.links).toEqual([{ href: 'https://ejemplo.es/blog/entrada', nofollow: false }]);
    const empty = parseSeoHtml('', PAGE);
    expect(empty).toMatchObject({ title: null, description: null, h1: [], canonical: null });
  });

  it('robots: meta y cabecera X-Robots-Tag', () => {
    expect(seoRobotsDirectives('', 'noindex')).toEqual({ noindex: true, nofollow: false });
    expect(seoRobotsDirectives('none', undefined)).toEqual({ noindex: true, nofollow: true });
    expect(seoRobotsDirectives('index, follow', 'googlebot: nofollow')).toEqual({
      noindex: false,
      nofollow: true,
    });
    expect(seoRobotsDirectives('', undefined)).toEqual({ noindex: false, nofollow: false });
  });

  it('enlaces y entidades', () => {
    expect(resolveSeoHref('javascript:void(0)', PAGE)).toBeNull();
    expect(resolveSeoHref('//cdn.ejemplo.es/x', PAGE)).toBe('https://cdn.ejemplo.es/x');
    expect(resolveSeoHref('../a?b=1#c', PAGE)).toBe('https://ejemplo.es/a?b=1');
    expect(decodeHtmlEntities('A&ntilde;o &#8364; &#x41; &desconocida;')).toBe(
      'Año € A &desconocida;',
    );
  });
});
