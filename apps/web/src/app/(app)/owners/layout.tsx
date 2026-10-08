import { FeatureGate } from '@/components/auth/feature-gate';

export default function OwnersLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="multi_owner">{children}</FeatureGate>;
}
