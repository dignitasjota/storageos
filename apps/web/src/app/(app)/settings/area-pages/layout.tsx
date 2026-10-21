import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Extra «SEO local». */
export default function AreaPagesLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="local_seo">{children}</FeatureGate>;
}
