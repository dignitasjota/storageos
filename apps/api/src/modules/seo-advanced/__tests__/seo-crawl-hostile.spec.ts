import {
  parseSeoRobotsTxt,
  parseSeoSitemap,
  seoCrawlExcluded,
  seoGlobMatch,
  seoRobotsAllowed,
} from '@storageos/shared';

import { parseSeoHtml, resolveSeoHref } from '../crawler/seo-html';

/** Lo que tarda algo (ms). Con las expresiones antiguas cada caso tardaba de segundos a horas. */
function ms(fn: () => unknown): number {
  const t = Date.now();
  fn();
  return Date.now() - t;
}
const FAST = 800;

describe('Entradas hostiles del rastreador: terminan en milisegundos', () => {
  it('mapa del sitio con <loc> sin cerrar y mil espacios', () => {
    const xml = `<urlset><loc>${' '.repeat(100_000)}`;
    expect(ms(() => parseSeoSitemap(xml))).toBeLessThan(FAST);
    expect(parseSeoSitemap(xml).urls).toEqual([]);
  });

  it('mapa del sitio con miles de <loc> y uno enorme', () => {
    const urls = Array.from({ length: 5000 }, (_, i) => `<loc>https://x.es/p${i}</loc>`).join('');
    const xml = `<urlset>${urls}<loc>https://x.es/${'a'.repeat(100_000)}</loc></urlset>`;
    let out: { urls: string[] } = { urls: [] };
    expect(ms(() => (out = parseSeoSitemap(xml)))).toBeLessThan(FAST);
    expect(out.urls).toHaveLength(5000);
  });

  it('el mapa sigue leyendo CDATA, entidades y mayúsculas', () => {
    const xml =
      '<URLSET><LOC> <![CDATA[https://x.es/a?b=1&c=2]]> </LOC><loc>https://x.es/b?x=1&amp;y=2</loc></URLSET>';
    expect(parseSeoSitemap(xml).urls).toEqual(['https://x.es/a?b=1&c=2', 'https://x.es/b?x=1&y=2']);
  });

  it('HTML con 3 MB de comentarios sin cerrar', () => {
    const html = `<html><title>Hola</title>${'<!--'.repeat(750_000)}`;
    let out = parseSeoHtml('', 'https://x.es/');
    expect(ms(() => (out = parseSeoHtml(html, 'https://x.es/')))).toBeLessThan(FAST);
    expect(out.title).toBe('Hola');
  });

  it('HTML con 3 MB de <a sin cerrar', () => {
    const html = `<html><head><title>T</title></head><body>${'<a '.repeat(1_000_000)}`;
    expect(ms(() => parseSeoHtml(html, 'https://x.es/'))).toBeLessThan(FAST);
  });

  it('HTML con muchos <script sin cerrar y <style a medias', () => {
    const html = `<title>X</title>${'<script x'.repeat(200_000)}`;
    expect(ms(() => parseSeoHtml(html, 'https://x.es/'))).toBeLessThan(FAST);
    const html2 = `<title>X</title>${'<style'.repeat(300_000)}<a href="/a">a</a>`;
    expect(ms(() => parseSeoHtml(html2, 'https://x.es/'))).toBeLessThan(FAST);
  });

  it('HTML normal: título, JSON-LD y enlaces siguen leyéndose; los comentarios y scripts, fuera', () => {
    const html = `<!-- <title>no</title> --><html lang="es"><head><title>Hola &amp; adiós</title>
      <script type="application/ld+json">{"@type":"LocalBusiness"}</script>
      <script>var x = "<title>no</title>"</script></head><body>
      <h1>Uno</h1><a href="/a" rel="nofollow">a</a><a href="/b">b</a><img src="x.png"></body></html>`;
    const out = parseSeoHtml(html, 'https://x.es/');
    expect(out.title).toBe('Hola & adiós');
    expect(out.jsonLdTypes).toEqual(['LocalBusiness']);
    expect(out.h1).toEqual(['Uno']);
    expect(out.links.map((l) => l.href)).toEqual(['https://x.es/a', 'https://x.es/b']);
    expect(out.imagesWithoutAlt).toBe(1);
  });

  it('un enlace de 100 KB se descarta', () => {
    expect(resolveSeoHref(`/${'a'.repeat(100_000)}`, 'https://x.es/')).toBeNull();
    expect(resolveSeoHref('/ok', 'https://x.es/')).toBe('https://x.es/ok');
  });

  it('robots.txt con asteriscos en cadena y una ruta larga', () => {
    const robots = parseSeoRobotsTxt('User-agent: *\nDisallow: /*a*a*a*a*a*a*a*a*b$\n');
    const url = `https://x.es/${'a'.repeat(3000)}`;
    let res = { allowed: true } as { allowed: boolean };
    expect(ms(() => (res = seoRobotsAllowed(robots, 'TrasterOS-SEO-Crawler', url)))).toBeLessThan(
      FAST,
    );
    expect(res.allowed).toBe(true);
  });

  it('rutas excluidas con asteriscos en cadena', () => {
    const url = `https://x.es/${'a'.repeat(3000)}`;
    expect(ms(() => seoCrawlExcluded(url, ['/*a*a*a*a*a*a*a*b']))).toBeLessThan(FAST);
  });

  it('los comodines siguen funcionando como en robots.txt', () => {
    expect(seoGlobMatch('/privado/*', '/privado/x', false)).toBe(true);
    expect(seoGlobMatch('/*.pdf', '/a/b.pdf', true)).toBe(true);
    expect(seoGlobMatch('/*.pdf', '/a/b.pdf?x=1', true)).toBe(false);
    expect(seoGlobMatch('/a/*/c', '/a/b/c', false)).toBe(true);
    expect(seoGlobMatch('/a/*/c', '/a/c', false)).toBe(false);
    const robots = parseSeoRobotsTxt(
      'User-agent: *\nDisallow: /*?orden=\nAllow: /tienda/*?orden=precio\n',
    );
    expect(seoRobotsAllowed(robots, 'x', 'https://x.es/lista?orden=1').allowed).toBe(false);
    expect(seoRobotsAllowed(robots, 'x', 'https://x.es/tienda/a?orden=precio').allowed).toBe(true);
  });
});
