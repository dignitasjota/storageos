'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import { SocialConnectSection } from './connect-section';

import { useHasFeature } from '@/lib/auth/hooks';
import { useSocialSettings } from '@/lib/marketing/hooks';

/** Marketing → Redes sociales: Instagram y Facebook orgánico (Web Premium). */
export default function SocialPage() {
  const hasFeature = useHasFeature('web_premium');
  const settings = useSocialSettings(hasFeature);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Redes sociales</h1>
        <p className="text-sm text-muted-foreground">
          Seguidores, alcance y publicaciones de tu Instagram y tu página de Facebook.
        </p>
      </div>
      {!hasFeature ? (
        <p className="text-sm text-muted-foreground">
          Incluido en <strong>Web Premium</strong>.{' '}
          <Link href="/settings/saas-billing" className="text-primary hover:underline">
            Ver planes y extras
          </Link>
        </p>
      ) : settings.isLoading || !settings.data ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (
        <SocialConnectSection settings={settings.data} />
      )}
    </div>
  );
}
