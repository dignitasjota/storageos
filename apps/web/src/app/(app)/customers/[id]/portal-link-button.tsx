'use client';

import { Copy, KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { PortalMagicLinkDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useCreatePortalLink } from '@/lib/customers/hooks';

export function PortalLinkButton({ customerId }: { customerId: string }) {
  const create = useCreatePortalLink(customerId);
  const [link, setLink] = useState<PortalMagicLinkDto | null>(null);

  async function generate() {
    try {
      const res = await create.mutateAsync();
      setLink(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar el enlace.');
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success('Enlace copiado al portapapeles.');
    } catch {
      toast.error('No se pudo copiar; selecciona y copia a mano.');
    }
  }

  return (
    <>
      <Button variant="outline" onClick={generate} disabled={create.isPending}>
        {create.isPending ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <KeyRound className="mr-1 h-4 w-4" />
        )}
        Enlace de acceso al portal
      </Button>

      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enlace de acceso al portal</DialogTitle>
            <DialogDescription>
              Cópialo y envíaselo al inquilino (WhatsApp, SMS, email…). Le da acceso directo a su
              portal sin tener que pedir nada.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                readOnly
                value={link?.url ?? ''}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button onClick={copy} aria-label="Copiar enlace">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            {link && (
              <p className="text-xs text-muted-foreground">
                Válido hasta el{' '}
                {new Date(link.expiresAt).toLocaleDateString('es-ES', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
                . De un solo uso: se desactiva tras el primer acceso.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
