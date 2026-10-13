import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { buildLandingMetadata, LandingPageBody } from '../landing-shared';

import type { Metadata } from 'next';

/**
 * `/contacto` del dominio propio del tenant (dirección fija para campañas): la
 * web de una página, bajando sola a la sección. Solo en el dominio propio — en
 * la plataforma (`/s/<slug>/contacto`) no existe.
 */
async function onCustomDomain(slug: string): Promise<boolean> {
  return (await headers()).get('x-storageos-tenant-slug') === slug;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildLandingMetadata(slug, 'es', 'contacto');
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!(await onCustomDomain(slug))) notFound();
  return <LandingPageBody slug={slug} locale="es" section="contacto" />;
}
