'use client';

import { Eye, LogOut } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth/hooks';
import { leaveImpersonation } from '@/lib/auth/impersonation';
import { useAuthStore } from '@/lib/auth/store';

/**
 * Aviso fijo mientras el soporte de TrasterOS está dentro del panel de un
 * tenant: a quién, si es solo lectura, hasta qué hora y cómo salir. Al llegar
 * la hora de fin la sesión se cierra sola.
 */
export function ImpersonationBanner() {
  const me = useMe();
  const imp = me.data?.impersonation;

  useEffect(() => {
    if (!imp) return;
    const ms = new Date(imp.expiresAt).getTime() - Date.now();
    const exit = () => {
      useAuthStore.getState().clear();
      leaveImpersonation();
    };
    if (ms <= 0) {
      exit();
      return;
    }
    const timer = setTimeout(exit, ms);
    return () => clearTimeout(timer);
  }, [imp]);

  if (!imp || !me.data) return null;
  const until = new Date(imp.expiresAt).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-violet-300 bg-violet-50 px-4 py-2 text-sm text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200"
    >
      <Eye className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        Sesión de soporte en <strong>{me.data.tenant.name}</strong>
        {imp.readOnly ? ' · solo lectura' : ''} · termina a las {until}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        onClick={() => {
          useAuthStore.getState().clear();
          leaveImpersonation();
        }}
      >
        <LogOut className="mr-1 size-3.5" aria-hidden /> Salir
      </Button>
    </div>
  );
}
