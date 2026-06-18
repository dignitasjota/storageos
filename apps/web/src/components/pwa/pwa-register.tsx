'use client';

import { useEffect } from 'react';

/**
 * Registra el service worker de la PWA del inquilino. Solo en producción
 * (en dev el SW interfiere con el HMR de Next). Idempotente: el navegador
 * reutiliza el registro existente.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Silencioso: el SW es una mejora progresiva, no crítico.
      });
    };
    window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);

  return null;
}
