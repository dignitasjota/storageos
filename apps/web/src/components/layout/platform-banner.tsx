'use client';

import { usePlatformBanner } from '@/lib/platform/hooks';

const STYLES: Record<string, string> = {
  info: 'bg-blue-50 text-blue-800 border-blue-200',
  warning: 'bg-amber-50 text-amber-800 border-amber-200',
  critical: 'bg-red-50 text-red-800 border-red-200',
};

/** Banner global (mantenimiento/novedades) que el super admin muestra a todos. */
export function PlatformBanner() {
  const { data } = usePlatformBanner();
  if (!data?.enabled || !data.message) return null;
  return (
    <div className={`border-b px-4 py-2 text-center text-sm ${STYLES[data.level] ?? STYLES.info}`}>
      {data.message}
    </div>
  );
}
