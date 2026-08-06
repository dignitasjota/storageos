import { headers } from 'next/headers';

import type { ReactNode } from 'react';

import { PublicChrome } from '@/components/public/public-chrome';

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const h = await headers();
  const forcedBare = h.get('x-storageos-tenant-public') === '1';
  return <PublicChrome forcedBare={forcedBare}>{children}</PublicChrome>;
}
