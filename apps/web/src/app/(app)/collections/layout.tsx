import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Impagos (expedientes y candado): funcionalidad de pago. */
export default function CollectionsLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="collections">{children}</FeatureGate>;
}
