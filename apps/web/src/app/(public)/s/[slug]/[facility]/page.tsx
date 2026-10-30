import { headers } from 'next/headers';

import { buildFacilityMetadata, FacilityPageBody } from './facility-shared';

import type { Metadata } from 'next';

/** ¿Llega por el dominio propio del negocio? (cabecera que pone el middleware). */
async function onCustomDomain(slug: string): Promise<boolean> {
  return (await headers()).get('x-storageos-tenant-slug') === slug;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; facility: string }>;
}): Promise<Metadata> {
  const { slug, facility } = await params;
  return buildFacilityMetadata(slug, facility, 'es', await onCustomDomain(slug));
}

export default async function FacilityLandingPage({
  params,
}: {
  params: Promise<{ slug: string; facility: string }>;
}) {
  const { slug, facility } = await params;
  return (
    <FacilityPageBody
      slug={slug}
      facilitySlug={facility}
      locale="es"
      onCustomDomain={await onCustomDomain(slug)}
    />
  );
}
