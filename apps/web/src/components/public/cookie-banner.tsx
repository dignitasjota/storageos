'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'storageos.cookies-accepted';

/**
 * Aviso de cookies: aparece abajo hasta que el visitante lo acepta (se recuerda
 * en localStorage). Solo cubre cookies estrictamente necesarias, así que ofrece
 * «Aceptar» + enlace a la política; no bloquea la navegación.
 */
export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch {
      /* sin localStorage no mostramos el banner */
    }
  }, []);

  function accept() {
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-xl border border-border bg-background/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Usamos cookies estrictamente necesarias para que la plataforma funcione y sea segura. Al
          continuar, aceptas su uso. Más información en nuestra{' '}
          <Link href="/cookies" className="font-medium text-foreground underline">
            Política de Cookies
          </Link>
          .
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/cookies">Más información</Link>
          </Button>
          <Button size="sm" onClick={accept}>
            Aceptar
          </Button>
        </div>
      </div>
    </div>
  );
}
