import type { Metadata } from 'next';

import { AttributionRecorder } from '@/components/public/attribution-recorder';
import { TenantUnavailable } from '@/components/public/tenant-unavailable';
import { fetchTenantBrand } from '@/lib/tenant-brand';
import { tenantIconsMetadata } from '@/lib/tenant-favicon';

/** Favicon del tenant en todas las páginas de su web (si lo ha subido). */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return tenantIconsMetadata(slug);
}

export default async function TenantWebLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const brand = await fetchTenantBrand(slug);
  if (brand?.portalUnavailable) {
    return <TenantUnavailable brand={brand} kind="booking" />;
  }
  return (
    <>
      <AttributionRecorder slug={slug} />
      {children}
    </>
  );
}
