'use client';

import { resetConsent } from '@/components/public/cookie-consent';

/** Vuelve a mostrar el aviso de cookies para cambiar la elección. */
export function CookieSettingsLink({ label }: { label: string }) {
  return (
    <button type="button" onClick={resetConsent} className="hover:text-white">
      {label}
    </button>
  );
}
