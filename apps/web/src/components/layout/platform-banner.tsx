'use client';

import { usePlatformBanner } from '@/lib/platform/hooks';

const STYLES: Record<string, string> = {
  info: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-900',
  warning:
    'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900',
  critical:
    'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-900',
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
