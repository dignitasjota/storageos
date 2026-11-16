'use client';

import { useEffect } from 'react';

import { setStaffBrowser } from '@/lib/tenant-consent';

/**
 * Quien entra en el panel es del equipo: sus visitas a la web del negocio (en
 * el mismo dominio) no cuentan en las estadísticas. Respeta si pidió que sí.
 */
export function StaffNoTrack() {
  useEffect(() => {
    setStaffBrowser(true, true);
  }, []);
  return null;
}
