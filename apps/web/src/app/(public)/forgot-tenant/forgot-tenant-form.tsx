'use client';

import { ForgotTenantSchema } from '@storageos/shared';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

export function ForgotTenantForm() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = ForgotTenantSchema.safeParse({ email });
    if (!parsed.success) {
      toast.error('Escribe un email válido.');
      return;
    }
    setSending(true);
    try {
      await apiFetch<void>('/auth/forgot-tenant', {
        method: 'POST',
        json: parsed.data,
        requiresAuth: false,
      });
      setSent(true);
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.statusCode === 429
          ? 'Demasiados intentos. Espera un poco.'
          : 'No se pudo enviar. Inténtalo de nuevo.',
      );
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        Si ese email tiene una cuenta, te hemos enviado su identificador. Revisa también el correo
        no deseado.
      </p>
    );
  }
  return (
    <form method="post" className="space-y-4" onSubmit={submit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="forgot-tenant-email">Email</Label>
        <Input
          id="forgot-tenant-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={sending}>
        {sending ? 'Enviando…' : 'Enviarme el identificador'}
      </Button>
    </form>
  );
}
