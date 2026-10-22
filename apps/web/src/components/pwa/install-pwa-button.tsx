'use client';

import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Botón "Instalar app" que aparece solo cuando el navegador ofrece instalar la
 * PWA (`beforeinstallprompt`). En iOS no existe ese evento (se instala con
 * "Compartir → Añadir a pantalla de inicio"); ahí el botón no se muestra.
 */
export function InstallPwaButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const onInstalled = () => setDeferred(null);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label="Instalar app"
      title="Instalar app"
      className="shrink-0 px-2 sm:px-3"
      onClick={async () => {
        await deferred.prompt();
        await deferred.userChoice;
        setDeferred(null);
      }}
    >
      <Download className="h-4 w-4 sm:mr-1.5" />
      {/* En el móvil solo el icono: el texto no cabe en la cabecera. */}
      <span className="hidden sm:inline">Instalar app</span>
    </Button>
  );
}
