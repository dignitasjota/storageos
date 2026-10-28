'use client';

import { Loader2, Mail } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useCancelEmailChange, useEmailChange, useRequestEmailChange } from '@/lib/users/hooks';

/** Email de acceso con el botón para cambiarlo (se confirma desde el email nuevo). */
export function EmailChange({ email }: { email: string }) {
  const status = useEmailChange();
  const request = useRequestEmailChange();
  const cancel = useCancelEmailChange();
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const pending = status.data?.pendingEmail ?? null;

  async function submit() {
    try {
      await request.mutateAsync({ newEmail: newEmail.trim(), currentPassword: password });
      toast.success(`Te hemos enviado un enlace a ${newEmail.trim()} para confirmarlo.`);
      setOpen(false);
      setNewEmail('');
      setPassword('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo pedir el cambio.');
    }
  }

  return (
    <div className="space-y-2">
      <Label>Email de acceso</Label>
      <div className="flex gap-2">
        <Input value={email} disabled readOnly />
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          Cambiar
        </Button>
      </div>
      {pending && (
        <p className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          <Mail className="size-3.5" /> Pendiente de confirmar: {pending}. Abre el enlace que te
          hemos enviado ahí.
          <button
            type="button"
            className="font-medium underline"
            onClick={() => void cancel.mutateAsync()}
          >
            Cancelar
          </button>
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar el email de acceso</DialogTitle>
            <DialogDescription>
              Te enviaremos un enlace al email nuevo. Hasta que lo abras, sigues entrando con el
              actual.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-email">Email nuevo</Label>
              <Input
                id="new-email"
                type="email"
                autoComplete="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="email-change-password">Tu contraseña actual</Label>
              <Input
                id="email-change-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={request.isPending || !newEmail.includes('@') || !password}
            >
              {request.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              Enviar enlace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
