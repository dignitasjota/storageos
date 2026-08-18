import { buildFacilityMetadata, FacilityPageBody } from './facility-shared';

import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; facility: string }>;
}): Promise<Metadata> {
  const { slug, facility } = await params;
  return buildFacilityMetadata(slug, facility, 'es');
}

export default async function FacilityLandingPage({
  params,
}: {
  params: Promise<{ slug: string; facility: string }>;
}) {
  const { slug, facility } = await params;
  return <FacilityPageBody slug={slug} facilitySlug={facility} locale="es" />;
}
