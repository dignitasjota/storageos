'use client';

import { AlertTriangle, Info, OctagonAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PlatformBannerDto } from '@storageos/shared';

import { usePlatformBanner } from '@/lib/platform/hooks';

const STYLES: Record<string, string> = {
  info: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-900',
  warning:
    'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900',
  critical:
    'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-900',
};

const ICONS = { info: Info, warning: AlertTriangle, critical: OctagonAlert } as const;
const LABELS = { info: 'Información', warning: 'Aviso', critical: 'Importante' } as const;

/** Banners cerrados en este navegador (por su fecha de guardado: uno nuevo vuelve a salir). */
const DISMISS_KEY = 'storageos.platform-banner.dismissed';

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** Banner global (mantenimiento/novedades) que el super admin muestra a todos. */
export function PlatformBanner() {
  const { data } = usePlatformBanner();
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setDismissed(readDismissed()), []);

  if (!data?.enabled || !data.message) return null;
  if (data.endsAt && new Date(data.endsAt).getTime() <= Date.now()) return null;
  if (data.dismissible && dismissed === data.updatedAt) return null;

  return (
    <BannerBar
      banner={data}
      onDismiss={() => {
        try {
          window.localStorage.setItem(DISMISS_KEY, data.updatedAt);
        } catch {
          /* sin almacenamiento: se cierra solo en esta visita */
        }
        setDismissed(data.updatedAt);
      }}
    />
  );
}

/** Cómo lo verá el tenant (panel admin). */
export function PlatformBannerPreview({ banner }: { banner: PlatformBannerDto }) {
  return (
    <BannerBar
      banner={{ ...banner, dismissible: banner.dismissible && banner.level !== 'critical' }}
      onDismiss={() => undefined}
    />
  );
}

function BannerBar({ banner, onDismiss }: { banner: PlatformBannerDto; onDismiss: () => void }) {
  const Icon = ICONS[banner.level] ?? Info;
  return (
    <div
      role={banner.level === 'critical' ? 'alert' : 'status'}
      className={`flex items-center gap-2 border-b px-4 py-2 text-sm ${STYLES[banner.level] ?? STYLES.info}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="sr-only">{LABELS[banner.level] ?? LABELS.info}:</span>
      <p className="flex-1 text-center">{banner.message}</p>
      {banner.dismissible && (
        <button
          type="button"
          aria-label="Cerrar el aviso"
          title="Cerrar el aviso"
          className="shrink-0 rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
