import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Web Premium: gating por feature/add-on. */
export default function AreaPagesLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="web_premium">{children}</FeatureGate>;
}
