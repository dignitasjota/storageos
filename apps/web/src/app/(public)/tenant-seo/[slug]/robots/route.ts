import { tenantRobotsTxt } from '@storageos/shared';

import { tenantSeoEntry } from '../shared';

/**
 * robots.txt del dominio propio de un tenant (ver `shared.ts`). No bloquea
 * reserva, portal, firma ni pago: llevan `noindex` y Google tiene que poder
 * leerlo (`tenantRobotsTxt`, en `@storageos/shared`).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const entry = await tenantSeoEntry(slug);
  if (!entry?.customDomain) return new Response('Not found', { status: 404 });
  return new Response(tenantRobotsTxt(`https://${entry.customDomain}/sitemap.xml`), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
