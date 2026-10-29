import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Asistente IA del panel. */
export default function AiSettingsLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="ai_assistant">{children}</FeatureGate>;
}
