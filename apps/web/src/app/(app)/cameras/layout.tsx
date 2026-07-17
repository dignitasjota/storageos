'use client';

import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';


export default function CamerasLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="cameras">{children}</FeatureGate>;
}
