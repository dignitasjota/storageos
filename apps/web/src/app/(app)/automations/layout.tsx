import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Gating por plan: oculta el módulo si el plan del tenant no lo incluye. */
export default function FeatureLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="automations">{children}</FeatureGate>;
}
