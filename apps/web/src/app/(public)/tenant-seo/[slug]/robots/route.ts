import { tenantSeoEntry } from '../shared';

/** robots.txt del dominio propio de un tenant (ver `shared.ts`). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const entry = await tenantSeoEntry(slug);
  if (!entry?.customDomain) return new Response('Not found', { status: 404 });
  const body = [
    'User-Agent: *',
    'Allow: /',
    'Disallow: /portal',
    'Disallow: /sign',
    'Disallow: /pay',
    'Disallow: /book',
    'Disallow: /reservar',
    '',
    `Sitemap: https://${entry.customDomain}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
