'use client';

import { FileText } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import { useAcceptLegal, usePendingLegal } from '@/lib/platform/hooks';

const PUBLIC_PATH: Record<string, string> = {
  terms: '/terminos',
  privacy: '/privacidad',
  cookies: '/cookies',
  'data-deletion': '/eliminar-datos',
};

/**
 * Aviso de que TrasterOS ha cambiado sus términos o su política de privacidad:
 * el propietario lo lee y lo acepta (queda registrado). Los demás usuarios solo
 * ven el aviso.
 */
export function LegalAcceptanceBanner() {
  const { data: me } = useMe();
  const pending = usePendingLegal();
  const accept = useAcceptLegal();
  const items = pending.data ?? [];
  if (items.length === 0) return null;
  const isOwner = me?.user.role === 'owner';

  async function onAccept(id: string) {
    try {
      await accept.mutateAsync(id);
      toast.success('Aceptado. Gracias.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo aceptar.');
    }
  }

  return (
    <div className="space-y-2 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
      {items.map((v) => (
        <div key={v.id} className="flex flex-wrap items-center gap-2">
          <FileText className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Hemos actualizado{' '}
            <a
              href={PUBLIC_PATH[v.slug] ?? '/'}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline"
            >
              {v.title}
            </a>
            .{' '}
            {isOwner
              ? 'Léelo y acéptalo para seguir al día.'
              : 'El propietario de la cuenta tiene que aceptarlo.'}
          </span>
          {isOwner && (
            <Button
              size="sm"
              className="h-7"
              disabled={accept.isPending}
              onClick={() => void onAccept(v.id)}
            >
              He leído y acepto
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
