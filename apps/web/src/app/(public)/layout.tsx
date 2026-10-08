import { headers } from 'next/headers';

import type { ReactNode } from 'react';

import { PublicChrome } from '@/components/public/public-chrome';
import { fetchPlatformWebsite } from '@/lib/platform-website';

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const h = await headers();
  const forcedBare = h.get('x-storageos-tenant-public') === '1';
  // Las webs de los tenants no llevan el marco de la plataforma: sin petición.
  const website = forcedBare ? { logoUrl: null, contactForm: null } : await fetchPlatformWebsite();
  return (
    <PublicChrome
      forcedBare={forcedBare}
      logoUrl={website.logoUrl}
      hasContact={website.contactForm !== null}
    >
      {children}
    </PublicChrome>
  );
}
