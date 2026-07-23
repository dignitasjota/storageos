'use client';

import { Copy, KeyRound, Loader2, Link2, ShieldOff } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import {
  useCreatePasswordResetLink,
  useCreatePortalLink,
  useDisablePortalPassword,
} from '@/lib/customers/hooks';

export function PortalLinkButton({
  customerId,
  portalAccessEnabled = false,
  className,
}: {
  customerId: string;
  portalAccessEnabled?: boolean;
  className?: string;
}) {
  const createLink = useCreatePortalLink(customerId);
  const createReset = useCreatePasswordResetLink(customerId);
  const disable = useDisablePortalPassword(customerId);
  const [link, setLink] = useState<{ dto: PortalMagicLinkDto; kind: 'access' | 'reset' } | null>(
    null,
  );

  const busy = createLink.isPending || createReset.isPending || disable.isPending;

  async function genAccess() {
    try {
      setLink({ dto: await createLink.mutateAsync(), kind: 'access' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar el enlace.');
    }
  }

  async function genReset() {
    try {
      setLink({ dto: await createReset.mutateAsync(), kind: 'reset' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar el enlace.');
    }
  }

  async function disablePwd() {
    if (!confirm('¿Desactivar el acceso por contraseña de este inquilino?')) return;
    try {
      await disable.mutateAsync();
      toast.success('Acceso por contraseña desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.dto.url);
      toast.success('Enlace copiado al portapapeles.');
    } catch {
      toast.error('No se pudo copiar; selecciona y copia a mano.');
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={busy} className={className}>
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-1 h-4 w-4" />
            )}
            Acceso al portal
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Contraseña: {portalAccessEnabled ? 'activada' : 'no configurada'}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void genAccess()}>
            <Link2 className="mr-2 h-4 w-4" /> Enlace de acceso (un uso)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void genReset()}>
            <KeyRound className="mr-2 h-4 w-4" /> Enlace para establecer contraseña
          </DropdownMenuItem>
          {portalAccessEnabled && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => void disablePwd()}>
                <ShieldOff className="mr-2 h-4 w-4" /> Desactivar contraseña
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {link?.kind === 'reset' ? 'Enlace para la contraseña' : 'Enlace de acceso al portal'}
            </DialogTitle>
            <DialogDescription>
              {link?.kind === 'reset'
                ? 'Cópialo y envíaselo al inquilino: le lleva a una página para poner su contraseña de portal.'
                : 'Cópialo y envíaselo al inquilino (WhatsApp, SMS, email…). Le da acceso directo a su portal sin tener que pedir nada.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                readOnly
                value={link?.dto.url ?? ''}
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
                {new Date(link.dto.expiresAt).toLocaleDateString('es-ES', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
                . De un solo uso.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
