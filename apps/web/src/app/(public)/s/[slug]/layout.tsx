import type { Metadata } from 'next';

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

export default function TenantWebLayout({ children }: { children: React.ReactNode }) {
  return children;
}
