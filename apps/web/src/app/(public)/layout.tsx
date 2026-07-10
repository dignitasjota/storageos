import type { ReactNode } from 'react';

import { PublicChrome } from '@/components/public/public-chrome';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicChrome>{children}</PublicChrome>;
}
