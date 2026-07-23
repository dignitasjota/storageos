'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';

import type { PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

const PORTAL_SESSION_KEY = 'storageos.portal.session';

function storePortalSession(s: PortalSessionDto): void {
  try {
    localStorage.setItem(
      PORTAL_SESSION_KEY,
      JSON.stringify({ ...s, expiresAtMs: Date.now() + s.expiresIn * 1000 }),
    );
  } catch {
    /* localStorage no disponible */
  }
}

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      toast.error('Las contraseñas no coinciden.');
      return;
    }
    setLoading(true);
    try {
      const session = await apiFetch<PortalSessionDto>('/portal/login/reset', {
        method: 'POST',
        json: { token, password },
        requiresAuth: false,
      });
      storePortalSession(session);
      window.location.href = '/portal/consume';
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.body.message : 'El enlace no es válido o ha caducado.',
      );
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="space-y-3 text-center text-sm">
        <p>Enlace no válido.</p>
        <Button variant="outline" asChild>
          <a href="/portal/login">Ir al acceso</a>
        </Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div>
        <Label>Nueva contraseña (mín. 8)</Label>
        <Input
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          className="text-base sm:text-sm"
        />
      </div>
      <div>
        <Label>Repite la contraseña</Label>
        <Input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
          className="text-base sm:text-sm"
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading || !password || !confirm}>
        {loading ? 'Guardando...' : 'Guardar y entrar'}
      </Button>
    </form>
  );
}

export default function PortalResetPage() {
  return (
    <div className="container flex flex-col items-center gap-4 py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Nueva contraseña</CardTitle>
          <CardDescription>Elige una contraseña para acceder a tu portal.</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<p className="text-center text-sm text-muted-foreground">…</p>}>
            <ResetForm />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
