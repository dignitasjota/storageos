import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

/**
 * Revalidación on-demand de la web pública de un tenant. La API lo llama cuando
 * el tenant cambia su plantilla/textos/secciones para purgar la caché ISR al
 * instante (si no, tardaría la ventana de `revalidate` en verse). Protegido con
 * un secreto compartido (`REVALIDATE_SECRET`, el mismo en API y web).
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    // Sin secreto configurado, no se admite (evita un endpoint abierto).
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  let body: { slug?: unknown; secret?: unknown };
  try {
    body = (await req.json()) as { slug?: unknown; secret?: unknown };
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  if (body.secret !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 401 });
  }
  if (typeof body.slug !== 'string' || body.slug.length === 0) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  // `layout` revalida el segmento y todo lo anidado → cubre /s/[slug] y
  // /s/[slug]/[facility] (y el dominio propio, que reescribe a /s/[slug]).
  revalidatePath(`/s/${body.slug}`, 'layout');
  return NextResponse.json({ revalidated: true, slug: body.slug });
}
