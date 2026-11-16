'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

import { SocialConnectSection } from './connect-section';
import { SocialReportSection } from './report-section';

import { SectionError } from '@/components/dashboard/section-state';
import { useHasFeature } from '@/lib/auth/hooks';
import { useSocialSettings } from '@/lib/marketing/hooks';

/** Marketing → Redes sociales: Instagram y Facebook orgánico (Web Premium). */
export default function SocialPage() {
  const hasFeature = useHasFeature('web_premium');
  // La conexión se ve también sin Web Premium: así se puede desconectar.
  const settings = useSocialSettings(true);
  const s = settings.data;
  const downloading = !!s?.connected && s.status === 'connected' && !s.lastSyncedAt;
  // Mientras se descarga lo del primer mes, se mira cada pocos segundos.
  useEffect(() => {
    if (!downloading) return;
    const id = window.setInterval(() => void settings.refetch(), 5000);
    return () => window.clearInterval(id);
  }, [downloading, settings]);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Redes sociales</h1>
        <p className="text-sm text-muted-foreground">
          Seguidores, alcance y publicaciones de tu Instagram y tu página de Facebook.
        </p>
      </div>
      {settings.isError ? (
        <SectionError onRetry={() => void settings.refetch()} />
      ) : settings.isLoading || !s ? (
        <div role="status" aria-label="Cargando">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : !hasFeature ? (
        <>
          <p className="text-sm text-muted-foreground">
            {s.connected
              ? 'Tu plan ya no incluye Web Premium: los datos no se actualizan. Puedes desconectar la página y borrar el token. '
              : 'Incluido en Web Premium. '}
            <Link href="/settings/saas-billing" className="text-primary hover:underline">
              Ver planes y extras
            </Link>
          </p>
          {s.connected && <SocialConnectSection settings={s} hasFeature={false} />}
        </>
      ) : (
        <>
          <SocialConnectSection settings={s} hasFeature />
          {s.connected && !downloading && <SocialReportSection />}
        </>
      )}
    </div>
  );
}
